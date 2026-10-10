import { Worker } from "node:worker_threads";
import { listen } from "./listener";
import { type SandboxResult } from "./sandbox-result";
import { callTool, serializeToolResult, type SandboxTool } from "./tool";
import {
  isTimeoutMs,
  MAX_TIMEOUT_MS,
  type ToolReply,
  type WorkerStartupData,
  WorkerToMainMessage,
} from "./worker-protocol";

type WorkerCompletion = { ok: true; result: SandboxResult } | { ok: false; error: unknown };

export type ExecuteOptions = {
  /** Guest deadline in milliseconds, measured after the worker creates the VM. Defaults to 1000. */
  timeoutMs?: number;
  /** Optional parent budget from before worker construction through completion acceptance. Cleanup follows. */
  totalTimeoutMs?: number;
};

/** @internal The parent owns this deadline and writes the worker's shared interrupt flag. */
export type WorkerDeadline = {
  timeoutMs: number;
  expiresAt: number;
  interrupt: Int32Array<SharedArrayBuffer>;
};

/** Execute a JavaScript async function body in a fresh worker with host-owned tools. */
export async function execute(
  code: string,
  tools: Readonly<Record<string, SandboxTool>> = {},
  options: ExecuteOptions = {},
): Promise<SandboxResult> {
  const timeoutMs = options.timeoutMs ?? 1000;
  if (!isTimeoutMs(timeoutMs)) {
    throw new RangeError(`timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}.`);
  }
  const totalTimeoutMs = options.totalTimeoutMs;
  if (totalTimeoutMs !== undefined && !isTimeoutMs(totalTimeoutMs)) {
    throw new RangeError(`totalTimeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}.`);
  }
  const deadline: WorkerDeadline | undefined =
    totalTimeoutMs === undefined
      ? undefined
      : {
          timeoutMs: totalTimeoutMs,
          expiresAt: performance.now() + totalTimeoutMs,
          // Shared flag: 0 = continue, 1 = request interruption.
          // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer
          interrupt: new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
        };
  const registry = new Map(Object.entries(tools));
  const worker = new Worker(new URL("./worker-entry.ts", import.meta.url), {
    workerData: {
      type: "execute",
      code,
      toolNames: [...registry.keys()],
      timeoutMs,
      ...(deadline === undefined ? {} : { interruptBuffer: deadline.interrupt.buffer }),
    } satisfies WorkerStartupData,
  });
  return await superviseWorker(worker, registry, deadline);
}

/** @internal Takes ownership of a fresh, single-execution worker, including termination. */
export async function superviseWorker(
  worker: Worker,
  tools: ReadonlyMap<string, SandboxTool> = new Map(),
  deadline?: WorkerDeadline,
): Promise<SandboxResult> {
  // `await using` disposes this stack on scope exit, awaiting cleanup in reverse order.
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/await_using
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/AsyncDisposableStack
  await using cleanup = new AsyncDisposableStack();
  // Setup can throw before the wait is reached; rejecting here could leave an unobserved promise.
  const completion = Promise.withResolvers<WorkerCompletion>();
  let active = true;
  let lastCallId = 0;
  const isActive = () => {
    if (!active) return false;
    if (deadline === undefined || performance.now() < deadline.expiresAt) return true;
    active = false;
    Atomics.store(deadline.interrupt, 0, 1);
    completion.resolve({
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
  };
  const fail = (error: unknown) => {
    if (!isActive()) return;
    active = false;
    completion.resolve({ ok: false, error });
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
      active = false;
      completion.resolve({ ok: true, result: response.value.result });
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
        // Domain validation belongs to the callback; the protocol only checks JSON syntax.
        const result = await callTool(tool, call.args);
        // Converting a late result would run getters/toJSON after execution has ended.
        if (!isActive()) return;
        const serialized = serializeToolResult(result);
        // Host getters/toJSON cannot be interrupted and may exhaust the parent budget.
        if (!isActive()) return;
        worker.postMessage({
          type: "tool-result",
          callId: call.callId,
          result: serialized,
        } satisfies ToolReply);
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
  cleanup.defer(() => {
    active = false;
    if (deadline !== undefined) Atomics.store(deadline.interrupt, 0, 1);
  });
  worker.on("error", onError);
  listen(cleanup, worker, "message", onMessage);
  listen(cleanup, worker, "messageerror", () => {
    fail(new Error("Sandbox worker response could not be deserialized."));
  });
  listen(cleanup, worker, "exit", () => {
    fail(new Error("Sandbox worker closed before completion."));
  });
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
