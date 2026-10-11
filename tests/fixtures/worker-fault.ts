import { parentPort, workerData } from "node:worker_threads";
import { WorkerStartupData, type WorkerToMainMessage } from "../../src/worker-protocol";

if (!parentPort) throw new Error("Fixture requires a parent port");

const request = WorkerStartupData.decode(workerData);
if (!request.ok) throw new Error(request.message);

switch (request.value.code) {
  case "invalid-response":
    parentPort.postMessage({
      type: "completed",
      result: { ok: false, error: { kind: "unknown" } },
    });
    break;
  case "execution-failure":
    parentPort.postMessage({ type: "failed", reason: "execution" } satisfies WorkerToMainMessage);
    break;
  case "request-failure":
    parentPort.postMessage({ type: "failed", reason: "request" } satisfies WorkerToMainMessage);
    break;
  case "crash":
    throw new Error("Private fixture failure details");
  case "close":
    process.exit(1);
  case "duplicate":
    parentPort.postMessage({
      type: "completed",
      result: { ok: true, value: 42 },
    } satisfies WorkerToMainMessage);
    parentPort.postMessage({ type: "failed", reason: "execution" } satisfies WorkerToMainMessage);
    break;
  case "idle":
    setInterval(() => {}, 1000);
    break;
  case "startup-stall":
    setInterval(() => {}, 1000);
    await new Promise<void>(() => {});
    break;
  case "startup-loop":
    parentPort.postMessage({
      type: "tool-call",
      callId: 1,
      name: "read",
      argsJson: undefined,
    } satisfies WorkerToMainMessage);
    while (true) {}

  case "call-and-crash":
    parentPort.postMessage({
      type: "tool-call",
      callId: 1,
      name: "read",
      argsJson: undefined,
    } satisfies WorkerToMainMessage);
    // The parent signals after the callback starts, keeping the failure deterministic.
    parentPort.once("message", () => {
      throw new Error("Private fixture failure details");
    });
    break;
  default:
    throw new Error("Unknown fixture scenario");
}
