import { parentPort, workerData } from "node:worker_threads";
import { execute } from "./sandbox";
import { WorkerRequest, type WorkerResponse } from "./worker-protocol";

if (!parentPort) throw new Error("Sandbox worker entry requires a parent port.");
const request = WorkerRequest.decode(workerData);

if (!request.ok) {
  parentPort.postMessage({ type: "failed", reason: "request" } satisfies WorkerResponse);
} else {
  parentPort.postMessage(await run(request.value.code));
}

async function run(code: string): Promise<WorkerResponse> {
  // Only the failure category crosses this boundary; arbitrary causes stay worker-local.
  // Posting the response stays outside the catch, so transport failures are not retried.
  try {
    return { type: "completed", result: await execute(code) };
  } catch {
    return { type: "failed", reason: "execution" };
  }
}
