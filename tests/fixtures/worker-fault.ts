import { WorkerRequest, type WorkerResponse } from "../../src/worker-protocol";

const submission = Promise.withResolvers<unknown>();
addEventListener("message", (event) => submission.resolve(event.data), { once: true });
const request = await submission.promise;
if (!WorkerRequest.is(request)) throw new Error("Invalid fixture request");

switch (request.code) {
  case "invalid-response":
    postMessage({ type: "completed", result: { ok: false, error: { kind: "unknown" } } });
    break;
  case "execution-failure":
    postMessage({ type: "failed", reason: "execution" } satisfies WorkerResponse);
    break;
  case "request-failure":
    postMessage({ type: "failed", reason: "request" } satisfies WorkerResponse);
    break;
  case "crash":
    throw new Error("Private fixture failure details");
  case "close":
    process.exit(1);
  case "duplicate":
    postMessage({ type: "completed", result: { ok: true, value: 42 } } satisfies WorkerResponse);
    postMessage({ type: "failed", reason: "execution" } satisfies WorkerResponse);
    break;
  case "idle":
    setInterval(() => {}, 1000);
    break;
  default:
    throw new Error("Unknown fixture scenario");
}
