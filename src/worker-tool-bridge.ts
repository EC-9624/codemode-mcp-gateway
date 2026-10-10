import { type MessagePort } from "node:worker_threads";
import { type QuickJSContext, type Scope } from "quickjs-emscripten";
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

  const bridge = installGuestToolBridge(
    context,
    toolNames,
    (name, argsJson) => {
      const failure = bridge.failure;

      if (!failure.ok) return Promise.reject(failure.error);

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

  const onMessage = (data: unknown) => {
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
  };
  const onMessageError = () =>
    bridge.fail(new Error("Sandbox tool reply could not be deserialized."));
  const onClose = () => bridge.fail(new Error("Sandbox tool transport closed before completion."));

  cleanup.defer(() => {
    for (const pendingReply of pendingReplies.values())
      pendingReply.reject(new Error("Sandbox tool transport closed."));
    pendingReplies.clear();
  });
  cleanup.defer(() => {
    port.off("message", onMessage);
  });
  port.on("message", onMessage);
  cleanup.defer(() => {
    port.off("messageerror", onMessageError);
  });
  port.on("messageerror", onMessageError);
  cleanup.defer(() => {
    port.off("close", onClose);
  });
  port.on("close", onClose);
  return bridge;
}
