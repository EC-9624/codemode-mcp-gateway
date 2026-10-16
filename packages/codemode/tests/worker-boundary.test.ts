import { describe, expect, spyOn, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { ToolResult } from "@codemode-mcp-gateway/codemode";
import { WorkerToMainMessage } from "../src/runtime/protocol.ts";
import { executionErrorOf } from "./support/execution-error.ts";
import { faultWorker, interruptFlag, startupData, superviseWorker } from "./support/workers.ts";
import { expectNoExecutionListeners, gateTermination } from "./support/worker-cleanup.ts";

// The public executor constructs valid startup data and hides worker-local dependencies.
// These probes retain actual malformed-startup and worker-local fault observations only.
describe("worker dependency boundary", () => {
  test("cancellation releases a worker stalled during startup", async () => {
    const controller = new AbortController();
    const control = { signal: controller.signal, interrupt: interruptFlag() };
    const worker = faultWorker("startup-stall");
    using terminate = spyOn(worker, "terminate");
    const completion = superviseWorker(worker, { control });

    controller.abort();
    const report = await completion;

    expect(report).toEqual({
      result: { ok: false, error: { kind: "cancelled", message: "Execution cancelled." } },
      calls: [],
    });
    expect(Atomics.load(control.interrupt, 0)).toBe(1);
    expect(terminate).toHaveBeenCalledTimes(1);
    expectNoExecutionListeners(worker, controller.signal);
  });

  test("total expiry interrupts stalled startup and waits for termination", async () => {
    const worker = faultWorker("startup-stall");

    const control = {
      deadline: { timeoutMs: 20, expiresAt: performance.now() + 20 },
      interrupt: interruptFlag(),
    };

    using termination = gateTermination(worker);
    let settled = false;

    const completion = superviseWorker(worker, { control }).then((report) => {
      settled = true;

      return report;
    });

    await termination.terminating;
    expect(settled).toBe(false);
    expect(Atomics.load(control.interrupt, 0)).toBe(1);
    expect(worker.listenerCount("message")).toBe(0);
    expect(worker.listenerCount("error")).toBe(1);
    worker.emit("message", { type: "completed", result: { ok: true, value: 42 } });
    worker.emit("error", new Error("Private late failure"));
    termination.release();
    const report = await completion;

    expect(report).toEqual({
      result: {
        ok: false,
        error: { kind: "timeout", message: "Execution exceeded the 20 ms total limit." },
      },
      calls: [],
    });
    expect(termination.terminate).toHaveBeenCalledTimes(1);
    expectNoExecutionListeners(worker);
  });
  test.each([
    ["invalid source", { code: 42 }],
    ["duplicate tool names", { toolNames: ["read", "read"] }],
    ["sparse tool names", { toolNames: Array(1) }],
    ["unresolved limits", { limits: {} }],
    ["oversized stack", { limits: { ...startupData("").limits, maxStackSizeBytes: 4194305 } }],
    ["unshared interruption", { interruptBuffer: new ArrayBuffer(4) }],
    ["wrong interrupt size", { interruptBuffer: new SharedArrayBuffer(8) }],
  ])("rejects startup with %s at the actual worker boundary", async (_name, overrides) => {
    const worker = new Worker(new URL("../src/runtime/worker.ts", import.meta.url), {
      workerData: { ...startupData("return 42;"), ...overrides },
    });

    try {
      const response = Promise.withResolvers<unknown>();
      worker.once("message", (data: unknown) => response.resolve(data));

      expect(await response.promise).toEqual({ type: "failed", reason: "request" });
    } finally {
      await worker.terminate();
    }
  });

  test("rejects a missing worker entry with controlled diagnostics", async () => {
    const worker = new Worker(new URL("./fixtures/missing-worker.ts", import.meta.url));

    const error = await executionErrorOf(superviseWorker(worker));

    expect(error.cause).toEqual(
      new Error("Sandbox worker failed. Internal error details are not transferred."),
    );
    expectNoExecutionListeners(worker);
  });

  test.each([
    ["parser", "worker-parser-fault.ts", "return 42;"],
    [
      "dispatcher",
      "worker-dispatch-fault.ts",
      "try { await tools.read(); } catch (error) { return error.message; }",
    ],
  ])("keeps actual worker-local %s exceptions private", async (_name, file, code) => {
    const worker = new Worker(new URL(`./fixtures/${file}`, import.meta.url), {
      workerData: startupData(code, ["read"]),
    });

    const error = await executionErrorOf(superviseWorker(worker));

    expect(error.cause).toEqual(
      new Error("Sandbox worker execution failed. Internal error details are not transferred."),
    );
    expectNoExecutionListeners(worker);
  });

  test("preserves an unexpected decoder exception without retrying", async () => {
    const worker = faultWorker("idle");
    const failure = new Error("Private decoder failure");

    using decode = spyOn(WorkerToMainMessage, "decode").mockImplementation(() => {
      throw failure;
    });

    using terminate = spyOn(worker, "terminate");
    const completion = executionErrorOf(superviseWorker(worker));

    expect(() =>
      worker.emit("message", { type: "completed", result: { ok: true, value: 42 } }),
    ).not.toThrow();
    const error = await completion;

    expect(error.cause).toBe(failure);
    expect(error.calls).toEqual([]);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledTimes(1);
    expectNoExecutionListeners(worker);
  });

  test("observes late callback rejection after a real worker crash", async () => {
    const worker = faultWorker("call-and-crash", ["read"]);
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));
    const signals: AbortSignal[] = [];
    using post = spyOn(worker, "postMessage");

    const completion = executionErrorOf(
      superviseWorker(worker, {
        tools: {
          read: (_args, { signal }) => {
            signals.push(signal);
            worker.postMessage("crash now");

            return late.promise;
          },
        },
      }),
    );

    const error = await completion;
    late.reject(new Error("Private late failure"));
    await Bun.sleep(0);

    expect(error.cause).toEqual(
      new Error("Sandbox worker failed. Internal error details are not transferred."),
    );
    expect(error.calls).toEqual([
      { callId: 1, name: "read", status: "interrupted", reason: "sandbox-error" },
    ]);
    expect(signals[0]?.aborted).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    expectNoExecutionListeners(worker);
  });
});
