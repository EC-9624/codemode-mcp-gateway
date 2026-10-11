import { Worker } from "node:worker_threads";
import { Buffer } from "node:buffer";
import {
  DEFAULT_LIMITS,
  isByteLimit,
  isCallCount,
  MAX_CALL_COUNT,
  MAX_LIMIT_BYTES,
  MAX_STACK_SIZE_BYTES,
} from "./execution-limits";
import { createCallLog, SandboxExecutionError, type ExecutionReport } from "./execution-report";
import { listen } from "./listener";
import { type GuestResult, type SandboxResult } from "./sandbox-result";
import { callTool, serializeToolResult, type SandboxTool } from "./tool";
import { createToolCallBudget, type ToolCallLimits } from "./tool-call-budget";
import {
  isTimeoutMs,
  MAX_TIMEOUT_MS,
  type ToolReply,
  type WorkerStartupData,
  WorkerToMainMessage,
} from "./worker-protocol";

type WorkerCompletion =
  | { ok: true; result: GuestResult | ReturnType<typeof cancelled> }
  | { ok: false; error: unknown };

export type ExecuteOptions = {
  /** Guest deadline in milliseconds, measured after the worker creates the VM. Defaults to 1000. */
  timeoutMs?: number;
  /** Optional parent budget from before worker construction through completion acceptance. Cleanup follows. */
  totalTimeoutMs?: number;
  /** Caller cancellation. The reason stays private; worker cleanup is still awaited. */
  signal?: AbortSignal;
  /** QuickJS guest heap limit in bytes. Defaults to 64 MiB. */
  memoryLimitBytes?: number;
  /** QuickJS stack limit in bytes, at most 4 MiB. Defaults to 1 MiB. */
  maxStackSizeBytes?: number;
  /** Submitted source limit in UTF-8 bytes, before worker startup. Defaults to 256 KiB. */
  maxSourceBytes?: number;
  /** Total admitted calls per execution, including failed responses. Defaults to 100. */
  maxToolCalls?: number;
  /** Outstanding calls per execution. Exceeding this limit stops execution. Defaults to 10. */
  maxConcurrentToolCalls?: number;
};

/** @internal Parent-owned controls; only the interrupt buffer crosses into the worker. */
export type WorkerControl = {
  deadline?: { timeoutMs: number; expiresAt: number };
  signal?: AbortSignal;
  interrupt: Int32Array<SharedArrayBuffer>;
};

/** Run in a fresh worker. Reports retain parent-observed calls; infrastructure errors carry them too. */
export async function execute(
  code: string,
  tools: Readonly<Record<string, SandboxTool>> = {},
  options: ExecuteOptions = {},
): Promise<ExecutionReport> {
  const timeoutMs = options.timeoutMs ?? 1000;
  if (!isTimeoutMs(timeoutMs)) {
    throw new RangeError(`timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}.`);
  }

  const totalTimeoutMs = options.totalTimeoutMs;
  if (totalTimeoutMs !== undefined && !isTimeoutMs(totalTimeoutMs)) {
    throw new RangeError(`totalTimeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}.`);
  }

  const limits = {
    memoryLimitBytes:
      options.memoryLimitBytes === undefined
        ? DEFAULT_LIMITS.memoryLimitBytes
        : options.memoryLimitBytes,
    maxStackSizeBytes:
      options.maxStackSizeBytes === undefined
        ? DEFAULT_LIMITS.maxStackSizeBytes
        : options.maxStackSizeBytes,
    maxSourceBytes:
      options.maxSourceBytes === undefined ? DEFAULT_LIMITS.maxSourceBytes : options.maxSourceBytes,
  };

  for (const [name, value] of Object.entries(limits)) {
    const maximum = name === "maxStackSizeBytes" ? MAX_STACK_SIZE_BYTES : MAX_LIMIT_BYTES;
    if (!isByteLimit(value, maximum)) {
      throw new RangeError(`${name} must be an integer from 1 to ${maximum}.`);
    }
  }

  const callLimits = {
    maxToolCalls:
      options.maxToolCalls === undefined ? DEFAULT_LIMITS.maxToolCalls : options.maxToolCalls,
    maxConcurrentToolCalls:
      options.maxConcurrentToolCalls === undefined
        ? DEFAULT_LIMITS.maxConcurrentToolCalls
        : options.maxConcurrentToolCalls,
  };

  for (const [name, value] of Object.entries(callLimits)) {
    if (!isCallCount(value)) {
      throw new RangeError(`${name} must be an integer from 1 to ${MAX_CALL_COUNT}.`);
    }
  }

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

  const control: WorkerControl = {
    ...(totalTimeoutMs === undefined
      ? {}
      : { deadline: { timeoutMs: totalTimeoutMs, expiresAt: performance.now() + totalTimeoutMs } }),
    ...(signal === undefined ? {} : { signal }),
    // Shared flag: 0 = continue, 1 = request interruption.
    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer
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
    worker = new Worker(new URL("./worker-entry.ts", import.meta.url), {
      workerData: {
        type: "execute",
        code,
        toolNames: [...registry.keys()],
        timeoutMs,
        memoryLimitBytes: limits.memoryLimitBytes,
        maxStackSizeBytes: limits.maxStackSizeBytes,
        ...callLimits,
        interruptBuffer: control.interrupt.buffer,
      } satisfies WorkerStartupData,
    });
  } catch (cause) {
    throw new SandboxExecutionError([], cause);
  }

  return await superviseWorker(worker, registry, control, callLimits);
}

/** @internal Takes ownership of a fresh, single-execution worker, including termination. */
export async function superviseWorker(
  worker: Worker,
  tools: ReadonlyMap<string, SandboxTool> = new Map(),
  control?: WorkerControl,
  limits: ToolCallLimits = DEFAULT_LIMITS,
): Promise<ExecutionReport> {
  const calls = createCallLog();
  try {
    const result = await runWorker(worker, tools, control, calls, limits);

    return { result, calls: calls.close("sandbox-error") };
  } catch (cause) {
    // Catch outside the ownership scope so failed termination also carries the snapshot.
    throw new SandboxExecutionError(calls.close("sandbox-error"), cause);
  }
}

async function runWorker(
  worker: Worker,
  tools: ReadonlyMap<string, SandboxTool>,
  control: WorkerControl | undefined,
  calls: ReturnType<typeof createCallLog>,
  limits: ToolCallLimits,
): Promise<SandboxResult> {
  // `await using` disposes this stack on scope exit, awaiting cleanup in reverse order.
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/await_using
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/AsyncDisposableStack
  await using cleanup = new AsyncDisposableStack();

  // Setup can throw before the wait is reached; rejecting here could leave an unobserved promise.
  const completion = Promise.withResolvers<WorkerCompletion>();
  // A separate controller keeps caller reasons private and also handles timeout/failure.
  // https://developer.mozilla.org/en-US/docs/Web/API/AbortController
  const toolController = new AbortController();
  const context = { signal: toolController.signal };
  const budget = createToolCallBudget(limits);
  const deadline = control?.deadline;
  const signal = control?.signal;
  let state: "active" | "succeeded" | "stopped" = "active";
  let lastCallId = 0;

  const stop = () => {
    if (state === "active") state = "stopped";

    calls.close("sandbox-error");

    if (control !== undefined) Atomics.store(control.interrupt, 0, 1);

    // Abort listeners run synchronously. Close dispatch first and never forward caller reasons.
    if (state === "stopped")
      toolController.abort(new DOMException("Sandbox execution ended.", "AbortError"));
  };

  const finish = (outcome: WorkerCompletion) => {
    if (state !== "active") return;

    state = outcome.ok && outcome.result.ok ? "succeeded" : "stopped";
    if (outcome.ok && !outcome.result.ok) {
      const error = outcome.result.error;
      if (error.kind === "limit") {
        calls.close(error.resource === "tool-calls" ? "call-limit" : "concurrency-limit");
      } else {
        calls.close(error.kind === "script" ? "script-error" : error.kind);
      }
    } else {
      calls.close("sandbox-error");
    }

    completion.resolve(outcome);
    stop();
  };

  const isActive = () => {
    if (state !== "active") return false;

    // An already elapsed total deadline wins when cancellation is first observed.
    if (deadline !== undefined && performance.now() >= deadline.expiresAt) {
      finish({
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

    if (signal?.aborted) {
      finish({ ok: true, result: cancelled() });

      return false;
    }

    return true;
  };

  const fail = (error: unknown) => {
    if (!isActive()) return;

    finish({ ok: false, error });
  };

  const onMessage = (data: unknown) => {
    if (!isActive()) return;

    const response = WorkerToMainMessage.decode(data);
    // Decoding can consume the remaining budget before the timer gets a turn.
    if (!isActive()) return;

    if (!response.ok) {
      fail(new Error(response.message));

      return;
    }

    if (response.value.type === "completed") {
      finish({ ok: true, result: response.value.result });

      return;
    }

    if (response.value.type === "tool-call") {
      const call = response.value;
      const tool = tools.get(call.name);
      // Calls are posted in invocation order; replies may complete in any order.
      if (call.callId !== lastCallId + 1 || !tool) {
        fail(new Error("Sandbox worker requested an unknown tool or invalid call ID."));

        return;
      }

      lastCallId = call.callId;

      const dispatch = async () => {
        if (!isActive()) return;

        const limit = budget.admit();
        if (limit !== undefined) {
          finish({ ok: true, result: { ok: false, error: limit } });

          return;
        }

        try {
          calls.dispatch(call.callId, call.name);
          // Domain validation belongs to the callback; the protocol only checks JSON syntax.
          const result = await callTool(tool, call.args, context);
          // Converting a late result would run getters/toJSON after execution has ended.
          if (!isActive()) return;

          const serialized = serializeToolResult(result);
          // Host getters/toJSON cannot be interrupted and may exhaust the parent budget.
          if (!isActive()) return;

          calls.complete(call.callId, serialized);
          worker.postMessage({
            type: "tool-result",
            callId: call.callId,
            result: serialized,
          } satisfies ToolReply);
        } finally {
          budget.release();
        }
      };

      // Catching dispatch as a tool failure would let guests recover from broken transport.
      void dispatch().then(undefined, fail);

      return;
    }

    const message =
      response.value.reason === "request"
        ? "Sandbox worker rejected the execution request."
        : "Sandbox worker execution failed. Internal error details are not transferred.";

    fail(new Error(message));
  };

  const onError = () => {
    fail(new Error("Sandbox worker failed. Internal error details are not transferred."));
  };

  // Keep an error listener until termination settles: EventEmitter throws unhandled errors.
  // It is registered before termination is deferred, so its removal runs last.
  cleanup.defer(() => {
    worker.off("error", onError);
  });
  cleanup.defer(async () => {
    await worker.terminate();
  });
  cleanup.defer(stop);

  worker.on("error", onError);
  listen(cleanup, worker, "message", onMessage);
  listen(cleanup, worker, "messageerror", () => {
    fail(new Error("Sandbox worker response could not be deserialized."));
  });
  listen(cleanup, worker, "exit", () => {
    fail(new Error("Sandbox worker closed before completion."));
  });

  if (signal !== undefined) {
    const onAbort = () => {
      isActive();
    };

    cleanup.defer(() => signal.removeEventListener("abort", onAbort));
    signal.addEventListener("abort", onAbort, { once: true });
  }

  // Also covers cancellation during worker construction or listener registration.
  isActive();

  if (deadline !== undefined) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    cleanup.defer(() => clearTimeout(timer));

    const tick = () => {
      if (!isActive()) return;

      // Re-arm if the host timer wakes before the monotonic deadline.
      timer = setTimeout(tick, Math.max(1, Math.ceil(deadline.expiresAt - performance.now())));
    };

    tick();
  }

  // Await inside the cleanup scope; returning the promise would terminate early.
  const outcome = await completion.promise;
  if (!outcome.ok) throw outcome.error;

  return outcome.result;
}

function cancelled() {
  return {
    ok: false,
    error: { kind: "cancelled", message: "Execution cancelled." },
  } satisfies SandboxResult;
}
