import { type SandboxResult } from "./sandbox";
import { type WorkerRequest, WorkerResponse } from "./worker-protocol";

/** Experimental worker execution without host tools; the existing execute API is unchanged. */
export async function executeInWorker(code: string): Promise<SandboxResult> {
  const worker = new Worker(new URL("./worker-entry.ts", import.meta.url).href, { ref: true });
  return await executeWorker(worker, code);
}

/** @internal Takes ownership of a fresh, single-execution worker, including termination. */
export async function executeWorker(worker: Worker, code: string): Promise<SandboxResult> {
  using cleanup = new DisposableStack();
  // Bun's terminate() requests termination; it does not acknowledge thread exit.
  cleanup.defer(() => worker.terminate());
  const completion = Promise.withResolvers<SandboxResult>();
  const onMessage = (event: MessageEvent<unknown>) => {
    if (!WorkerResponse.is(event.data)) {
      completion.reject(
        new Error("Sandbox worker returned an invalid response. Check the worker protocol."),
      );
      return;
    }
    if (event.data.type === "completed") {
      completion.resolve(event.data.result);
      return;
    }
    const message =
      event.data.reason === "request"
        ? "Sandbox worker rejected the execution request. Check the worker protocol."
        : "Sandbox worker execution failed. Check worker initialization and sandbox infrastructure.";
    completion.reject(new Error(message));
  };
  const onError = (event: ErrorEvent) => {
    event.preventDefault();
    completion.reject(
      new Error("Sandbox worker failed. Check the worker entry point and initialization."),
    );
  };
  const onMessageError = () => {
    completion.reject(
      new Error("Sandbox worker response could not be deserialized. Check the worker protocol."),
    );
  };
  const onClose = () => {
    completion.reject(
      new Error("Sandbox worker closed before completion. Check the worker lifecycle."),
    );
  };

  // Register removal before adding, so partial listener setup also unwinds.
  cleanup.defer(() => worker.removeEventListener("message", onMessage));
  worker.addEventListener("message", onMessage);
  cleanup.defer(() => worker.removeEventListener("error", onError));
  worker.addEventListener("error", onError);
  cleanup.defer(() => worker.removeEventListener("messageerror", onMessageError));
  worker.addEventListener("messageerror", onMessageError);
  cleanup.defer(() => worker.removeEventListener("close", onClose));
  worker.addEventListener("close", onClose);
  worker.postMessage({ type: "execute", code } satisfies WorkerRequest);
  // Await inside the cleanup scope; returning the promise would terminate early.
  return await completion.promise;
}
