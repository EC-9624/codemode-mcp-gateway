import { WorkerRequest, type WorkerResponse } from "./worker-protocol";

// Install before any async initialization: Bun drops messages without a listener.
const submission = Promise.withResolvers<unknown>();
addEventListener("message", (event) => submission.resolve(event.data), { once: true });
const request = await submission.promise;

if (!WorkerRequest.is(request)) {
  postMessage({ type: "failed", reason: "request" } satisfies WorkerResponse);
} else {
  postMessage(await run(request.code));
}

async function run(code: string): Promise<WorkerResponse> {
  // This worker boundary cannot transfer arbitrary infrastructure errors safely.
  // Posting the response stays outside the catch, so transport failures are not retried.
  try {
    const { execute } = await import("./sandbox");
    return { type: "completed", result: await execute(code) };
  } catch {
    return { type: "failed", reason: "execution" };
  }
}
