import { Worker } from "node:worker_threads";
import { Buffer } from "node:buffer";
import { type ExecuteOptions, type ExecutionReport, type SandboxOptions } from "./types.ts";
import { type SandboxTool } from "./tools.ts";
import { SandboxExecutionError } from "./errors.ts";
import { resolveOptions, type ResolvedOptions } from "./runtime/options.ts";
import { cancelled, WorkerExecution, type WorkerControl } from "./runtime/execution.ts";
import { type WorkerStartupData } from "./runtime/protocol.ts";

/** Owns fixed policy and default tools. Each execution gets its own tool snapshot, worker, and VM. */
export class CodeExecutor {
  private readonly tools: ReadonlyMap<string, SandboxTool>;
  private readonly options: ResolvedOptions;
  private activeExecutions = 0;

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
   * worker and VM; pre-aborted, oversized, or over-capacity submissions create neither.
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

    const maximum = this.options.maxConcurrentExecutions;
    if (this.activeExecutions >= maximum) {
      return {
        result: {
          ok: false,
          error: {
            kind: "limit",
            resource: "executions",
            maximum,
            message: `Executor reached the ${maximum} concurrent-execution limit.`,
          },
        },
        calls: [],
      };
    }

    this.activeExecutions++;
    let worker: Worker | undefined;
    try {
      let tools: ReadonlyMap<string, SandboxTool>;
      try {
        const supplied = options.tools;
        tools = supplied === undefined ? this.tools : new Map(Object.entries(supplied));
      } catch (cause) {
        throw new SandboxExecutionError([], cause);
      }

      const totalTimeoutMs = this.options.totalTimeoutMs;
      const onToolException = this.options.onToolException;

      const control: WorkerControl = {
        ...(onToolException === undefined ? {} : { onToolException }),
        ...(totalTimeoutMs === undefined
          ? {}
          : {
              deadline: {
                timeoutMs: totalTimeoutMs,
                expiresAt: performance.now() + totalTimeoutMs,
              },
            }),
        ...(signal === undefined ? {} : { signal }),
        // A busy QuickJS worker cannot process cancellation messages. Its interrupt
        // handler polls this shared flag: 0 = continue, 1 = request interruption.
        interrupt: new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
      };

      try {
        const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";

        // Standalone builds embed worker.js as a second entrypoint beside the executable.
        worker = new Worker(
          new URL(
            Bun.isStandaloneExecutable ? "./worker.js" : `./runtime/worker.${extension}`,
            import.meta.url,
          ),
          {
            workerData: {
              type: "execute",
              code,
              toolNames: [...tools.keys()],
              limits,
              interruptBuffer: control.interrupt.buffer,
            } satisfies WorkerStartupData,
          },
        );
      } catch (cause) {
        throw new SandboxExecutionError([], cause);
      }

      return await new WorkerExecution(worker, tools, control, limits).run();
    } finally {
      // Failed termination can leave a live worker. Releasing on rejection would admit
      // another worker while that one still consumes capacity.
      if (worker !== undefined && worker.threadId !== -1) {
        worker.once("exit", () => this.activeExecutions--);
      } else {
        this.activeExecutions--;
      }
    }
  }
}
