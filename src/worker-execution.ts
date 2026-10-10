import { Worker } from "node:worker_threads";
import { type SandboxResult } from "./sandbox-result";
import { callTool, serializeToolResult, type SandboxTool } from "./tool";
import { type ToolReply, type WorkerRequest, WorkerResponse } from "./worker-protocol";

export async function runSandbox(
  code: string,
  tools: Readonly<Record<string, SandboxTool>> = {},
): Promise<SandboxResult> {
  const registry = new Map(Object.entries(tools));
  const worker = new Worker(new URL("./worker-entry.ts", import.meta.url), {
    workerData: { type: "execute", code, toolNames: [...registry.keys()] } satisfies WorkerRequest,
  });
  return await executeWorker(worker, registry);
}

/** @internal Takes ownership of a fresh, single-execution worker, including termination. */
export async function executeWorker(
  worker: Worker,
  tools: ReadonlyMap<string, SandboxTool> = new Map(),
): Promise<SandboxResult> {
  await using cleanup = new AsyncDisposableStack();
  const completion = Promise.withResolvers<SandboxResult>();
  let active = true;
  let lastCallId = 0;
  const fail = (error: unknown) => {
    if (!active) return;
    active = false;
    completion.reject(error);
  };
  const onMessage = (data: unknown) => {
    if (!active) return;
    const response = WorkerResponse.decode(data);
    if (!response.ok) {
      fail(new Error(response.message));
      return;
    }
    if (response.value.type === "completed") {
      active = false;
      completion.resolve(response.value.result);
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
        const args: unknown = call.argsJson === undefined ? undefined : JSON.parse(call.argsJson);
        const result = await callTool(tool, args);
        // Converting a late result would run getters/toJSON after execution has ended.
        if (!active) return;
        const serialized = serializeToolResult(result);
        if (!active) return;
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
  const onMessageError = () => {
    fail(new Error("Sandbox worker response could not be deserialized."));
  };
  const onExit = () => {
    fail(new Error("Sandbox worker closed before completion."));
  };

  // Keep an error listener until termination settles: EventEmitter throws unhandled errors.
  cleanup.defer(() => {
    worker.off("error", onError);
  });
  cleanup.defer(async () => {
    await worker.terminate();
  });
  worker.on("error", onError);
  // Register removal before adding, so partial listener setup also unwinds.
  cleanup.defer(() => {
    worker.off("message", onMessage);
  });
  worker.on("message", onMessage);
  cleanup.defer(() => {
    worker.off("messageerror", onMessageError);
  });
  worker.on("messageerror", onMessageError);
  cleanup.defer(() => {
    worker.off("exit", onExit);
  });
  worker.on("exit", onExit);
  cleanup.defer(() => {
    active = false;
  });
  // Await inside the cleanup scope; returning the promise would terminate early.
  return await completion.promise;
}
