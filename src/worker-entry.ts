import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { installWorkerToolBridge } from "./worker-tool-bridge";
import { executeEngine } from "./sandbox-engine";
import { WorkerStartupData, type WorkerToMainMessage } from "./worker-protocol";

if (!parentPort) throw new Error("Sandbox worker entry requires a parent port.");

const startup = WorkerStartupData.decode(workerData);

if (!startup.ok) {
  parentPort.postMessage({ type: "failed", reason: "request" } satisfies WorkerToMainMessage);
} else {
  parentPort.postMessage(await run(startup.value, parentPort));
}

async function run(startup: WorkerStartupData, port: MessagePort): Promise<WorkerToMainMessage> {
  // Only the failure category crosses this boundary; arbitrary causes stay worker-local.
  // Posting the response stays outside the catch, so transport failures are not retried.
  try {
    // `using` disposes this stack on scope exit; cleanup runs in reverse order.
    // Forced worker termination may skip cleanup.
    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/using
    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/DisposableStack
    using cleanup = new DisposableStack();

    const result = await executeEngine(
      startup.code,
      startup,
      (vm, scope) => installWorkerToolBridge(vm, startup.toolNames, port, scope, cleanup, startup),
      startup.interruptBuffer === undefined ? undefined : new Int32Array(startup.interruptBuffer),
    );

    return { type: "completed", result };
  } catch {
    return { type: "failed", reason: "execution" };
  }
}
