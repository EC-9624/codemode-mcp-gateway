import { Worker } from "node:worker_threads";
import { type SandboxResult } from "./sandbox";
import { type WorkerRequest, WorkerResponse } from "./worker-protocol";

/** Experimental worker execution without host tools; the existing execute API is unchanged. */
export async function executeInWorker(code: string): Promise<SandboxResult> {
  const worker = new Worker(new URL("./worker-entry.ts", import.meta.url), {
    workerData: { type: "execute", code } satisfies WorkerRequest,
  });
  return await executeWorker(worker);
}

/** @internal Takes ownership of a fresh, single-execution worker, including termination. */
export async function executeWorker(worker: Worker): Promise<SandboxResult> {
  await using cleanup = new AsyncDisposableStack();
  const completion = Promise.withResolvers<SandboxResult>();
  const onMessage = (data: unknown) => {
    const response = WorkerResponse.decode(data);
    if (!response.ok) {
      completion.reject(new Error(response.message));
      return;
    }
    if (response.value.type === "completed") {
      completion.resolve(response.value.result);
      return;
    }
    const message =
      response.value.reason === "request"
        ? "Sandbox worker rejected the execution request."
        : "Sandbox worker execution failed. Internal error details are not transferred.";
    completion.reject(new Error(message));
  };
  const onError = () => {
    completion.reject(
      new Error("Sandbox worker failed. Internal error details are not transferred."),
    );
  };
  const onMessageError = () => {
    completion.reject(new Error("Sandbox worker response could not be deserialized."));
  };
  const onExit = () => {
    completion.reject(new Error("Sandbox worker closed before completion."));
  };

  // Keep an error listener until termination settles: EventEmitter throws unhandled errors.
  cleanup.defer(() => {
    worker.off("error", onError);
  });
  cleanup.defer(async () => {
    await worker.terminate();
  });
  worker.on("error", onError);
  // Register removal before adding, so partial listener setup also unwinds.
  cleanup.defer(() => {
    worker.off("message", onMessage);
  });
  worker.on("message", onMessage);
  cleanup.defer(() => {
    worker.off("messageerror", onMessageError);
  });
  worker.on("messageerror", onMessageError);
  cleanup.defer(() => {
    worker.off("exit", onExit);
  });
  worker.on("exit", onExit);
  // Await inside the cleanup scope; returning the promise would terminate early.
  return await completion.promise;
}
