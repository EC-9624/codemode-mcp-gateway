import { Worker } from "node:worker_threads";
import { Buffer } from "node:buffer";
import { type ExecuteOptions, type ExecutionReport, type SandboxOptions } from "./types.js";
import { type SandboxTool } from "./tools.js";
import { SandboxExecutionError } from "./errors.js";
import { resolveOptions, type ResolvedOptions } from "./runtime/options.js";
import { cancelled, WorkerExecution, type WorkerControl } from "./runtime/execution.js";
import { type WorkerStartupData } from "./runtime/protocol.js";

/** Owns fixed configuration and tool bindings. Each execution gets a fresh worker and VM. */
export class CodemodeSandbox {
  private readonly tools: ReadonlyMap<string, SandboxTool>;
  private readonly options: ResolvedOptions;

  /**
   * Validate fixed limits before reading and snapshotting tool bindings. No worker starts here.
   * Invalid limits throw RangeError; registry access failures throw SandboxExecutionError.
   */
  constructor(options: SandboxOptions = {}) {
    this.options = resolveOptions(options);
    try {
      this.tools = new Map(Object.entries(options.tools ?? {}));
    } catch (cause) {
      throw new SandboxExecutionError([], cause);
    }
  }

  /**
   * Run an async function body: top-level await and return work. Admitted runs get a fresh
   * worker and VM; pre-aborted or oversized submissions return without creating either.
   * Expected guest failures resolve in report.result; infrastructure failures reject with
   * SandboxExecutionError. Settlement waits for worker cleanup, not cancelled host tools.
   */
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
      worker = new Worker(
        new URL(
          import.meta.url.endsWith(".ts") ? "./runtime/worker.ts" : "./runtime/worker.js",
          import.meta.url,
        ),
        {
          workerData: {
            type: "execute",
            code,
            toolNames: [...this.tools.keys()],
            limits,
            interruptBuffer: control.interrupt.buffer,
          } satisfies WorkerStartupData,
        },
      );
    } catch (cause) {
      throw new SandboxExecutionError([], cause);
    }

    return await new WorkerExecution(worker, this.tools, control, limits).run();
  }
}
