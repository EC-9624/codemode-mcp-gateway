import { type MessagePort } from "node:worker_threads";
import { type QuickJSContext, type Scope } from "quickjs-emscripten";
import { listen } from "./listener.js";
import { installGuestToolBridge } from "./guest-bridge.js";
import { type WorkerToMainMessage } from "./protocol.js";
import { type ToolCallLimits } from "./budget.js";

/** The worker owns transport listeners; promises and resolvers remain in the guest. */
export function installWorkerToolBridge(
  context: QuickJSContext,
  toolNames: readonly string[],
  port: MessagePort,
  scope: Scope,
  cleanup: DisposableStack,
  limits: ToolCallLimits,
) {
  // The guest bridge owns admission and stops invoking after a limit or failure.
  const bridge = installGuestToolBridge(
    context,
    toolNames,
    (call) => {
      port.postMessage({
        type: "tool-call",
        callId: call.callId,
        name: call.name,
        argsJson: call.argsJson ?? undefined,
      } satisfies WorkerToMainMessage);
    },
    scope,
    limits,
  );

  listen(cleanup, port, "message", (data) => bridge.receive(data));
  listen(cleanup, port, "messageerror", () =>
    bridge.fail(new Error("Sandbox tool reply could not be deserialized.")),
  );
  listen(cleanup, port, "close", () =>
    bridge.fail(new Error("Sandbox tool transport closed before completion.")),
  );

  return bridge;
}
