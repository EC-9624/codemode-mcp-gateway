import { Worker } from "node:worker_threads";
import { type WorkerStartupData } from "../../src/worker-protocol";

/** Starts the real worker entry with a valid request that exposes `read`. */
export function toolWorker(code: string, timeoutMs = 1000, interruptBuffer?: SharedArrayBuffer) {
  return new Worker(new URL("../../src/worker-entry.ts", import.meta.url), {
    workerData: {
      type: "execute",
      code,
      toolNames: ["read"],
      timeoutMs,
      ...(interruptBuffer === undefined ? {} : { interruptBuffer }),
    } satisfies WorkerStartupData,
  });
}

/** Starts the fault fixture, which interprets the request code as a scenario name. */
export function faultWorker(scenario: string, toolNames: string[] = []) {
  return new Worker(new URL("../fixtures/worker-fault.ts", import.meta.url), {
    workerData: {
      type: "execute",
      code: scenario,
      toolNames,
      timeoutMs: 1000,
    } satisfies WorkerStartupData,
  });
}
