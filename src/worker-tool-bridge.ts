import { type MessagePort } from "node:worker_threads";
import { type QuickJSContext, type Scope } from "quickjs-emscripten";
import { listen } from "./listener";
import { type SerializedToolResult } from "./tool";
import { installGuestToolBridge } from "./guest-tool-bridge";
import { ToolReply, type WorkerToMainMessage } from "./worker-protocol";

/** The worker owns correlation and listeners; the engine scope owns guest resolvers. */
export function connectGuestToolsToMainThread(
  context: QuickJSContext,
  toolNames: readonly string[],
  port: MessagePort,
  scope: Scope,
  cleanup: DisposableStack,
) {
  const pendingReplies = new Map<number, PromiseWithResolvers<SerializedToolResult>>();
  let nextCallId = 1;

  // The guest bridge stops invoking once it records a failure, so no failure check is needed here.
  const bridge = installGuestToolBridge(
    context,
    toolNames,
    (name, argsJson) => {
      if (!Number.isSafeInteger(nextCallId)) throw new Error("Sandbox tool call IDs exhausted.");

      const callId = nextCallId++;
      const pendingReply = Promise.withResolvers<SerializedToolResult>();

      // Storing the resolver first would leave a pending call if posting throws.
      port.postMessage({ type: "tool-call", callId, name, argsJson } satisfies WorkerToMainMessage);
      pendingReplies.set(callId, pendingReply);

      return pendingReply.promise;
    },
    scope,
  );

  cleanup.defer(() => {
    for (const pendingReply of pendingReplies.values())
      pendingReply.reject(new Error("Sandbox tool transport closed."));
    pendingReplies.clear();
  });
  listen(cleanup, port, "message", (data: unknown) => {
    if (!bridge.failure.ok) return;
    const decodedReply = ToolReply.decode(data);
    if (!decodedReply.ok) {
      bridge.fail(new Error(decodedReply.message));
      return;
    }
    const pendingReply = pendingReplies.get(decodedReply.value.callId);
    if (!pendingReply) {
      bridge.fail(new Error("Sandbox worker received an unknown or duplicate tool reply."));
      return;
    }
    pendingReplies.delete(decodedReply.value.callId);
    pendingReply.resolve(decodedReply.value.result);
  });
  listen(cleanup, port, "messageerror", () =>
    bridge.fail(new Error("Sandbox tool reply could not be deserialized.")),
  );
  listen(cleanup, port, "close", () =>
    bridge.fail(new Error("Sandbox tool transport closed before completion.")),
  );
  return bridge;
}
