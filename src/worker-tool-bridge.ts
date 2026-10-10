import { type MessagePort } from "node:worker_threads";
import { type QuickJSContext, type Scope } from "quickjs-emscripten";
import { type SerializedToolResult } from "./tool";
import { installGuestToolBridge } from "./guest-tool-bridge";
import { ToolReply, type WorkerResponse } from "./worker-protocol";

/** The worker owns correlation and listeners; the engine scope owns guest resolvers. */
export function connectGuestToolsToMainThread(
  context: QuickJSContext,
  names: readonly string[],
  port: MessagePort,
  scope: Scope,
  cleanup: DisposableStack,
) {
  const pending = new Map<number, PromiseWithResolvers<SerializedToolResult>>();
  let nextId = 1;
  const bridge = installGuestToolBridge(
    context,
    names,
    (name, argsJson) => {
      if (!bridge.failure.ok) return Promise.reject(bridge.failure.error);
      if (!Number.isSafeInteger(nextId)) throw new Error("Sandbox tool call IDs exhausted.");
      const callId = nextId++;
      const call = Promise.withResolvers<SerializedToolResult>();
      // Storing the resolver first would leave a pending call if posting throws.
      port.postMessage({ type: "tool-call", callId, name, argsJson } satisfies WorkerResponse);
      pending.set(callId, call);
      return call.promise;
    },
    scope,
  );

  const onMessage = (data: unknown) => {
    if (!bridge.failure.ok) return;
    const reply = ToolReply.decode(data);
    if (!reply.ok) {
      bridge.fail(new Error(reply.message));
      return;
    }
    const call = pending.get(reply.value.callId);
    if (!call) {
      bridge.fail(new Error("Sandbox worker received an unknown or duplicate tool reply."));
      return;
    }
    pending.delete(reply.value.callId);
    call.resolve(reply.value.result);
  };
  const onMessageError = () =>
    bridge.fail(new Error("Sandbox tool reply could not be deserialized."));
  const onClose = () => bridge.fail(new Error("Sandbox tool transport closed before completion."));

  cleanup.defer(() => {
    for (const call of pending.values()) call.reject(new Error("Sandbox tool transport closed."));
    pending.clear();
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
