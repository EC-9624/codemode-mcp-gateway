/**
 * Host-side supervisor for one worker. Tool callbacks, call records, caller cancellation,
 * and the optional total deadline stay here; only names, JSON data, limits, and the
 * interrupt buffer cross into the worker.
 *
 * A run moves from ready to running to finished:
 * 1. Observe worker events and caller cancellation, then dispatch admitted tool calls.
 * 2. Accept the first completion, cancellation, timeout, or infrastructure failure.
 * 3. Close dispatch and snapshot calls before aborting tools; abort listeners can re-enter.
 * 4. Remove listeners and await worker termination before settling the host promise.
 *
 * Late replies cannot change the snapshot. Cleanup can still fail after an outcome was
 * selected, so run() wraps execution and cleanup failures with the same call observations.
 */
import { type Worker } from "node:worker_threads";
import { createCallLog } from "./report.ts";
import { listen } from "./listener.ts";
import {
  type ExecutionReport,
  type InterruptionReason,
  type SandboxResult,
  type ToolException,
} from "../types.ts";
import { SandboxExecutionError } from "../errors.ts";
import { callTool, serializeToolResult, type SandboxTool } from "../tools.ts";
import { createToolCallBudget, type ToolCallLimits } from "./budget.ts";
import {
  type DecodedWorkerMessage,
  type GuestResult,
  type ToolReply,
  WorkerToMainMessage,
} from "./protocol.ts";

type WorkerCompletion =
  | { ok: true; result: GuestResult | ReturnType<typeof cancelled> }
  | { ok: false; error: unknown };

/** Parent-owned controls; only the interrupt buffer crosses into the worker. */
export type WorkerControl = {
  deadline?: { timeoutMs: number; expiresAt: number };
  signal?: AbortSignal;
  interrupt: Int32Array<SharedArrayBuffer>;
  onToolException?: (exception: ToolException) => void;
};

/** One run owns a fresh worker, its listeners, and termination. */
export class WorkerExecution {
  private readonly worker: Worker;
  private readonly tools: ReadonlyMap<string, SandboxTool>;
  private readonly control: WorkerControl;
  private readonly budget: ReturnType<typeof createToolCallBudget>;
  private readonly calls = createCallLog();
  // Setup can throw before the wait is reached; rejecting here could leave an unobserved promise.
  private readonly completion = Promise.withResolvers<
    WorkerCompletion & { calls: ExecutionReport["calls"] }
  >();
  // A separate controller keeps caller reasons private and also handles timeout/failure.
  private readonly toolController = new AbortController();
  private readonly context = { signal: this.toolController.signal };
  private state: "ready" | "running" | "finished" = "ready";
  private lastCallId = 0;

  constructor(
    worker: Worker,
    tools: ReadonlyMap<string, SandboxTool>,
    control: WorkerControl,
    limits: ToolCallLimits,
  ) {
    this.worker = worker;
    this.tools = tools;
    this.control = control;
    this.budget = createToolCallBudget(limits);
  }

  async run(): Promise<ExecutionReport> {
    if (this.state !== "ready") throw new Error("A worker execution can only run once.");

    this.state = "running";
    try {
      return await this.observe();
    } catch (cause) {
      // Catch outside the ownership scope so failed termination also carries the snapshot.
      throw new SandboxExecutionError(this.calls.close("sandbox-error"), cause);
    }
  }

  private async observe(): Promise<ExecutionReport> {
    await using cleanup = new AsyncDisposableStack();

    const onError = () => {
      this.fail(new Error("Sandbox worker failed. Internal error details are not transferred."));
    };

    // Rejected termination can leave a live worker. Contain its errors until actual exit.
    cleanup.defer(() => {
      if (this.worker.threadId === -1) this.worker.off("error", onError);
      else this.worker.once("exit", () => this.worker.off("error", onError));
    });
    cleanup.defer(async () => {
      await this.worker.terminate();
    });
    try {
      this.worker.on("error", onError);
      listen(cleanup, this.worker, "message", (data) => this.handleMessage(data));
      listen(cleanup, this.worker, "messageerror", () => {
        this.fail(new Error("Sandbox worker response could not be deserialized."));
      });
      listen(cleanup, this.worker, "exit", () => {
        this.fail(new Error("Sandbox worker closed before completion."));
      });

      const signal = this.control.signal;
      if (signal !== undefined) {
        const onAbort = () => {
          this.checkRunning();
        };

        cleanup.defer(() => signal.removeEventListener("abort", onAbort));
        signal.addEventListener("abort", onAbort, { once: true });
      }

      // Also covers cancellation during worker construction or listener registration.
      this.checkRunning();
      const deadline = this.control.deadline;
      if (deadline !== undefined) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        cleanup.defer(() => clearTimeout(timer));

        const tick = () => {
          if (!this.checkRunning()) return;

          // Re-arm if the host timer wakes before the monotonic deadline.
          timer = setTimeout(tick, Math.max(1, Math.ceil(deadline.expiresAt - performance.now())));
        };

        tick();
      }
    } catch (error) {
      // Setup can fail before awaiting completion. Close dispatch before cleanup or tool aborts reenter.
      this.finish({ ok: false, error });
      throw error;
    }

    // Await inside the cleanup scope; returning the promise would terminate early.
    const outcome = await this.completion.promise;
    if (!outcome.ok) throw outcome.error;

    return { result: outcome.result, calls: outcome.calls };
  }

  private finish(outcome: WorkerCompletion): void {
    if (this.state !== "running") return;

    // Abort listeners run synchronously. Fix the outcome and snapshot before notifying tools.
    this.state = "finished";
    const snapshot = this.calls.close(interruptionReason(outcome));
    this.completion.resolve({ ...outcome, calls: snapshot });
    Atomics.store(this.control.interrupt, 0, 1);

    if (!outcome.ok || !outcome.result.ok) {
      this.toolController.abort(new DOMException("Sandbox execution ended.", "AbortError"));
    }
  }

  private checkRunning(): boolean {
    if (this.state !== "running") return false;

    const deadline = this.control.deadline;
    // An already elapsed total deadline wins when cancellation is first observed.
    if (deadline !== undefined && performance.now() >= deadline.expiresAt) {
      this.finish({
        ok: true,
        result: {
          ok: false,
          error: {
            kind: "timeout",
            message: `Execution exceeded the ${deadline.timeoutMs} ms total limit.`,
          },
        },
      });

      return false;
    }

    if (this.control.signal?.aborted) {
      this.finish({ ok: true, result: cancelled() });

      return false;
    }

    return true;
  }

  private fail(error: unknown): void {
    if (!this.checkRunning()) return;

    this.finish({ ok: false, error });
  }

  private handleMessage(data: unknown): void {
    if (!this.checkRunning()) return;

    let response: ReturnType<typeof WorkerToMainMessage.decode>;
    try {
      response = WorkerToMainMessage.decode(data);
    } catch (error) {
      this.fail(error);

      return;
    }

    // Decoding can consume the remaining budget before the timer gets a turn.
    if (!this.checkRunning()) return;

    if (!response.ok) {
      this.fail(new Error(response.message));

      return;
    }

    if (response.value.type === "completed") {
      this.finish({ ok: true, result: response.value.result });

      return;
    }

    if (response.value.type === "tool-call") {
      // Catching dispatch as a tool failure would let guests recover from broken transport.
      void this.dispatch(response.value).then(undefined, (error: unknown) => this.fail(error));

      return;
    }

    const message =
      response.value.reason === "request"
        ? "Sandbox worker rejected the execution request."
        : "Sandbox worker execution failed. Internal error details are not transferred.";

    this.fail(new Error(message));
  }

  private async dispatch(
    call: Extract<DecodedWorkerMessage, { type: "tool-call" }>,
  ): Promise<void> {
    const tool = this.tools.get(call.name);
    // Calls are posted in invocation order; replies may complete in any order.
    if (call.callId !== this.lastCallId + 1 || !tool) {
      this.fail(new Error("Sandbox worker requested an unknown tool or invalid call ID."));

      return;
    }

    this.lastCallId = call.callId;
    if (!this.checkRunning()) return;

    const limit = this.budget.admit() ?? this.budget.start();
    if (limit !== undefined) {
      this.finish({ ok: true, result: { ok: false, error: limit } });

      return;
    }

    try {
      this.calls.dispatch(call.callId, call.name);

      // Domain validation belongs to the callback; the protocol only checks JSON syntax.
      const result = await callTool(tool, call.args, this.context);

      // Converting a late result would run getters/toJSON after execution has ended.
      // Aborted tools also commonly fail late; those causes are not diagnostics.
      if (!this.checkRunning()) return;

      if (!result.ok && "cause" in result.error) {
        this.control.onToolException?.({
          callId: call.callId,
          name: call.name,
          cause: result.error.cause,
        });
        if (!this.checkRunning()) return;
      }

      const serialized = serializeToolResult(result);
      // Host getters/toJSON cannot be interrupted and may exhaust the parent budget.
      if (!this.checkRunning()) return;

      this.calls.complete(call.callId);
      this.worker.postMessage({
        type: "tool-result",
        callId: call.callId,
        result: serialized,
      } satisfies ToolReply);
    } finally {
      this.budget.release();
    }
  }
}

function interruptionReason(outcome: WorkerCompletion): InterruptionReason {
  if (!outcome.ok || outcome.result.ok) return "sandbox-error";

  const error = outcome.result.error;
  if (error.kind !== "limit") return error.kind === "script" ? "script-error" : error.kind;

  const reasons = {
    "tool-calls": "call-limit",
    "concurrent-tool-calls": "concurrency-limit",
    output: "output-limit",
  } as const;

  return reasons[error.resource];
}

export function cancelled() {
  return {
    ok: false,
    error: { kind: "cancelled", message: "Execution cancelled." },
  } satisfies SandboxResult;
}
