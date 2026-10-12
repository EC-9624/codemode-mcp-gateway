import { Worker } from "node:worker_threads";
import { DEFAULT_LIMITS, type ExecutionLimits } from "../../src/runtime/limits";
import { type WorkerStartupData } from "../../src/runtime/protocol";
import { WorkerExecution, type WorkerControl } from "../../src/runtime/execution";
import { type SandboxTool } from "@cmg/codemode";
import { type ToolCallLimits } from "../../src/runtime/budget";

export { type WorkerControl } from "../../src/runtime/execution";

/** A fresh parent/worker interrupt flag, initially clear. */
export function interruptFlag() {
  return new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
}

/** Valid startup data with default limits; scenarios override only the fields they test. */
export function startupData(
  code: string,
  toolNames: string[] = [],
  overrides: { limits?: Partial<ExecutionLimits>; interruptBuffer?: SharedArrayBuffer } = {},
): WorkerStartupData {
  return {
    type: "execute",
    code,
    toolNames,
    limits: { ...DEFAULT_LIMITS, ...overrides.limits },
    interruptBuffer: overrides.interruptBuffer ?? interruptFlag().buffer,
  };
}

/** Exercises the real execution owner with an injected worker. */
export function superviseWorker(
  worker: Worker,
  options: {
    tools?: Readonly<Record<string, SandboxTool>>;
    control?: WorkerControl;
    limits?: ToolCallLimits;
  } = {},
) {
  return new WorkerExecution(
    worker,
    new Map(Object.entries(options.tools ?? {})),
    options.control ?? { interrupt: interruptFlag() },
    options.limits ?? DEFAULT_LIMITS,
  ).run();
}

/** Starts the real worker entry with a valid request that exposes `read`. */
export function toolWorker(code: string, timeoutMs = 1000, interruptBuffer?: SharedArrayBuffer) {
  return new Worker(new URL("../../src/runtime/worker.ts", import.meta.url), {
    workerData: startupData(code, ["read"], {
      limits: { timeoutMs },
      ...(interruptBuffer === undefined ? {} : { interruptBuffer }),
    }),
  });
}

/** Starts the fault fixture, which interprets the request code as a scenario name. */
export function faultWorker(scenario: string, toolNames: string[] = []) {
  return new Worker(new URL("../fixtures/worker-fault.ts", import.meta.url), {
    workerData: startupData(scenario, toolNames),
  });
}
