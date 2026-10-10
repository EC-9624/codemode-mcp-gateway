import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { connectGuestToolsToMainThread } from "./worker-tool-bridge";
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
    using cleanup = new DisposableStack();
    const result = await executeEngine(startup.code, startup.timeoutMs, (vm, scope) =>
      connectGuestToolsToMainThread(vm, startup.toolNames, port, scope, cleanup),
    );
    return { type: "completed", result };
  } catch {
    return { type: "failed", reason: "execution" };
  }
}
