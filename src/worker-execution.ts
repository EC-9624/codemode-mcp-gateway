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
  const registry = new Map(Object.entries(tools));
  const worker = new Worker(new URL("./worker-entry.ts", import.meta.url), {
    workerData: {
      type: "execute",
      code,
      toolNames: [...registry.keys()],
      timeoutMs,
    } satisfies WorkerStartupData,
  });
  return await superviseWorker(worker, registry);
}

/** @internal Takes ownership of a fresh, single-execution worker, including termination. */
export async function superviseWorker(
  worker: Worker,
  tools: ReadonlyMap<string, SandboxTool> = new Map(),
): Promise<SandboxResult> {
  await using cleanup = new AsyncDisposableStack();
  // Setup can throw before the wait is reached; rejecting here could leave an unobserved promise.
  const completion = Promise.withResolvers<WorkerCompletion>();
  let active = true;
  let lastCallId = 0;
  const fail = (error: unknown) => {
    if (!active) return;
    active = false;
    completion.resolve({ ok: false, error });
  };
  const onMessage = (data: unknown) => {
    if (!active) return;
    const response = WorkerToMainMessage.decode(data);
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
        // Domain validation belongs to the callback; the protocol only checks JSON syntax.
        const result = await callTool(tool, call.args);
        // Converting a late result would run getters/toJSON after execution has ended.
        if (!active) return;
        worker.postMessage({
          type: "tool-result",
          callId: call.callId,
          result: serializeToolResult(result),
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
  });
  worker.on("error", onError);
  listen(cleanup, worker, "message", onMessage);
  listen(cleanup, worker, "messageerror", () => {
    fail(new Error("Sandbox worker response could not be deserialized."));
  });
  listen(cleanup, worker, "exit", () => {
    fail(new Error("Sandbox worker closed before completion."));
  });
  // Await inside the cleanup scope; returning the promise would terminate early.
  const outcome = await completion.promise;
  if (!outcome.ok) throw outcome.error;
  return outcome.result;
}
