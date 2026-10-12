import { expect, spyOn } from "bun:test";
import { getEventListeners } from "node:events";
import { type Worker } from "node:worker_threads";

// Kept apart from workers.ts: process fixtures import that module outside the test runner.

/**
 * Holds the spied `worker.terminate()` open after real termination until `release()`.
 * Disposal releases the gate and restores the spy, so a failed assertion cannot strand cleanup.
 */
export function gateTermination(worker: Worker) {
  const terminateWorker = worker.terminate.bind(worker);
  const terminating = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();

  const terminate = spyOn(worker, "terminate").mockImplementation(async () => {
    const code = await terminateWorker();
    terminating.resolve();
    await released.promise;

    return code;
  });

  return {
    terminate,
    terminating: terminating.promise,
    release: () => released.resolve(),
    [Symbol.dispose]() {
      released.resolve();
      terminate.mockRestore();
    },
  };
}

/** Asserts that a finished run removed its worker listeners and, when given, its abort listener. */
export function expectNoExecutionListeners(worker: Worker, signal?: AbortSignal) {
  for (const name of ["message", "messageerror", "exit", "error"]) {
    expect(worker.listenerCount(name)).toBe(0);
  }

  if (signal !== undefined) expect(getEventListeners(signal, "abort")).toHaveLength(0);
}
