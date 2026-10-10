import { parentPort, workerData } from "node:worker_threads";
import { WorkerRequest, type WorkerResponse } from "../../src/worker-protocol";

if (!parentPort) throw new Error("Fixture requires a parent port");
const request = WorkerRequest.decode(workerData);
if (!request.ok) throw new Error(request.message);

switch (request.value.code) {
  case "invalid-response":
    parentPort.postMessage({
      type: "completed",
      result: { ok: false, error: { kind: "unknown" } },
    });
    break;
  case "execution-failure":
    parentPort.postMessage({ type: "failed", reason: "execution" } satisfies WorkerResponse);
    break;
  case "request-failure":
    parentPort.postMessage({ type: "failed", reason: "request" } satisfies WorkerResponse);
    break;
  case "crash":
    throw new Error("Private fixture failure details");
  case "close":
    process.exit(1);
  case "duplicate":
    parentPort.postMessage({
      type: "completed",
      result: { ok: true, value: 42 },
    } satisfies WorkerResponse);
    parentPort.postMessage({ type: "failed", reason: "execution" } satisfies WorkerResponse);
    break;
  case "idle":
    setInterval(() => {}, 1000);
    break;
  case "call-and-crash":
    parentPort.postMessage({
      type: "tool-call",
      callId: 1,
      name: "read",
      argsJson: undefined,
    } satisfies WorkerResponse);
    // The parent signals after the callback starts, keeping the failure deterministic.
    parentPort.once("message", () => {
      throw new Error("Private fixture failure details");
    });
    break;
  default:
    throw new Error("Unknown fixture scenario");
}
