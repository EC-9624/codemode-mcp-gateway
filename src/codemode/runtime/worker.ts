import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { installWorkerToolBridge } from "./worker-bridge";
import { executeEngine } from "./engine";
import { WorkerStartupData, type WorkerToMainMessage } from "./protocol";

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
    // Forced worker termination may skip this cleanup.
    using cleanup = new DisposableStack();

    const result = await executeEngine(
      startup.code,
      startup.limits,
      (vm, scope) =>
        installWorkerToolBridge(vm, startup.toolNames, port, scope, cleanup, startup.limits),
      new Int32Array(startup.interruptBuffer),
    );

    return { type: "completed", result };
  } catch {
    return { type: "failed", reason: "execution" };
  }
}
