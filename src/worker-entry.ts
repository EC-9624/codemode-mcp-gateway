import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { connectGuestToolsToMainThread } from "./worker-tool-bridge";
import { executeEngine } from "./sandbox-engine";
import { WorkerRequest, type WorkerResponse } from "./worker-protocol";

if (!parentPort) throw new Error("Sandbox worker entry requires a parent port.");
const request = WorkerRequest.decode(workerData);

if (!request.ok) {
  parentPort.postMessage({ type: "failed", reason: "request" } satisfies WorkerResponse);
} else {
  parentPort.postMessage(await run(request.value, parentPort));
}

async function run(request: WorkerRequest, port: MessagePort): Promise<WorkerResponse> {
  // Only the failure category crosses this boundary; arbitrary causes stay worker-local.
  // Posting the response stays outside the catch, so transport failures are not retried.
  try {
    using cleanup = new DisposableStack();
    const result = await executeEngine(request.code, (vm, scope) =>
      connectGuestToolsToMainThread(vm, request.toolNames, port, scope, cleanup),
    );
    return { type: "completed", result };
  } catch {
    return { type: "failed", reason: "execution" };
  }
}
