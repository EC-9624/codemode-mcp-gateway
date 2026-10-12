import { Worker } from "node:worker_threads";
import { Buffer } from "node:buffer";
import { type ExecuteOptions, type ExecutionReport, type SandboxOptions } from "./types";
import { type SandboxTool } from "./tools";
import { SandboxExecutionError } from "./errors";
import { resolveOptions, type ResolvedOptions } from "./runtime/options";
import { cancelled, WorkerExecution, type WorkerControl } from "./runtime/execution";
import { type WorkerStartupData } from "./runtime/protocol";

/** Owns fixed configuration and tool bindings. Each execution gets a fresh worker and VM. */
export class CodemodeSandbox {
  private readonly tools: ReadonlyMap<string, SandboxTool>;
  private readonly options: ResolvedOptions;

  constructor(options: SandboxOptions = {}) {
    this.options = resolveOptions(options);
    try {
      this.tools = new Map(Object.entries(options.tools ?? {}));
    } catch (cause) {
      throw new SandboxExecutionError([], cause);
    }
  }

  async execute(code: string, options: ExecuteOptions = {}): Promise<ExecutionReport> {
    const limits = this.options.limits;
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

    const totalTimeoutMs = this.options.totalTimeoutMs;

    const control: WorkerControl = {
      ...(totalTimeoutMs === undefined
        ? {}
        : {
            deadline: { timeoutMs: totalTimeoutMs, expiresAt: performance.now() + totalTimeoutMs },
          }),
      ...(signal === undefined ? {} : { signal }),
      // Shared flag: 0 = continue, 1 = request interruption.
      interrupt: new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    };

    let worker: Worker;
    try {
      worker = new Worker(new URL("./runtime/worker.ts", import.meta.url), {
        workerData: {
          type: "execute",
          code,
          toolNames: [...this.tools.keys()],
          limits,
          interruptBuffer: control.interrupt.buffer,
        } satisfies WorkerStartupData,
      });
    } catch (cause) {
      throw new SandboxExecutionError([], cause);
    }

    return await new WorkerExecution(worker, this.tools, control, limits).run();
  }
}
