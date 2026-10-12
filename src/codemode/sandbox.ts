import { Worker } from "node:worker_threads";
import { Buffer } from "node:buffer";
import { type ExecuteOptions, type ExecutionReport, type SandboxOptions } from "./types";
import { type SandboxTool } from "./tools";
import { SandboxExecutionError } from "./errors";
import { resolveOptions, type ResolvedOptions } from "./runtime/options";
import { cancelled, WorkerExecution, type WorkerControl } from "./runtime/execution";
import { type WorkerStartupData } from "./runtime/protocol";

/** Holds tool bindings and defaults. Every execute call owns a fresh worker and VM. */
export class CodemodeSandbox {
  private readonly tools: Readonly<Record<string, SandboxTool>>;
  private readonly defaults: ResolvedOptions;

  constructor(options: SandboxOptions = {}) {
    this.defaults = resolveOptions(options);
    try {
      this.tools = Object.freeze(Object.fromEntries(Object.entries(options.tools ?? {})));
    } catch (cause) {
      throw new SandboxExecutionError([], cause);
    }
  }

  execute(code: string, options: ExecuteOptions = {}): Promise<ExecutionReport> {
    return run(code, this.tools, options, this.defaults);
  }
}

/** One-shot execution with per-call tools and options. Registry access follows admission. */
export function execute(
  code: string,
  tools: Readonly<Record<string, SandboxTool>> = {},
  options: ExecuteOptions = {},
): Promise<ExecutionReport> {
  return run(code, tools, options);
}

async function run(
  code: string,
  tools: Readonly<Record<string, SandboxTool>>,
  options: ExecuteOptions,
  defaults?: ResolvedOptions,
): Promise<ExecutionReport> {
  const resolved = resolveOptions(options, defaults);
  const limits = resolved.limits;
  const signal = options.signal;
  if (signal?.aborted) return { result: cancelled(), calls: [] };

  if (Buffer.byteLength(code, "utf8") > limits.maxSourceBytes) {
    return {
      result: {
        ok: false,
        error: {
          kind: "limit",
          resource: "source",
          maximum: limits.maxSourceBytes,
          message: `Source exceeds the ${limits.maxSourceBytes} byte limit.`,
        },
      },
      calls: [],
    };
  }

  const totalTimeoutMs = resolved.totalTimeoutMs;

  const control: WorkerControl = {
    ...(totalTimeoutMs === undefined
      ? {}
      : { deadline: { timeoutMs: totalTimeoutMs, expiresAt: performance.now() + totalTimeoutMs } }),
    ...(signal === undefined ? {} : { signal }),
    // Shared flag: 0 = continue, 1 = request interruption.
    interrupt: new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
  };

  let registry: Map<string, SandboxTool>;
  try {
    registry = new Map(Object.entries(tools));
  } catch (cause) {
    throw new SandboxExecutionError([], cause);
  }

  // Registry getters can synchronously cancel before a worker has been constructed.
  if (signal?.aborted) return { result: cancelled(), calls: [] };

  let worker: Worker;
  try {
    worker = new Worker(new URL("./runtime/worker.ts", import.meta.url), {
      workerData: {
        type: "execute",
        code,
        toolNames: [...registry.keys()],
        limits,
        interruptBuffer: control.interrupt.buffer,
      } satisfies WorkerStartupData,
    });
  } catch (cause) {
    throw new SandboxExecutionError([], cause);
  }

  return await new WorkerExecution(worker, registry, control, limits).run();
}
