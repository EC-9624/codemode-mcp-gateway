import { Worker } from "node:worker_threads";
import { DEFAULT_LIMITS } from "../../src/execution-limits";
import { type WorkerStartupData } from "../../src/worker-protocol";

/** Starts the real worker entry with a valid request that exposes `read`. */
export function toolWorker(code: string, timeoutMs = 1000, interruptBuffer?: SharedArrayBuffer) {
  return new Worker(new URL("../../src/worker-entry.ts", import.meta.url), {
    workerData: {
      type: "execute",
      code,
      toolNames: ["read"],
      timeoutMs,
      memoryLimitBytes: DEFAULT_LIMITS.memoryLimitBytes,
      maxStackSizeBytes: DEFAULT_LIMITS.maxStackSizeBytes,
      maxOutputBytes: DEFAULT_LIMITS.maxOutputBytes,
      maxToolCalls: DEFAULT_LIMITS.maxToolCalls,
      maxConcurrentToolCalls: DEFAULT_LIMITS.maxConcurrentToolCalls,
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
      memoryLimitBytes: DEFAULT_LIMITS.memoryLimitBytes,
      maxStackSizeBytes: DEFAULT_LIMITS.maxStackSizeBytes,
      maxOutputBytes: DEFAULT_LIMITS.maxOutputBytes,
      maxToolCalls: DEFAULT_LIMITS.maxToolCalls,
      maxConcurrentToolCalls: DEFAULT_LIMITS.maxConcurrentToolCalls,
    } satisfies WorkerStartupData,
  });
}
