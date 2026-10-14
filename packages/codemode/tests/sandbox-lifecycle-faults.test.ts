import { describe, expect, spyOn, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { CodeExecutor, ToolResult } from "@cmg/codemode";
import { captureWorker } from "./support/capture-worker.ts";
import { executionErrorOf } from "./support/execution-error.ts";
import { expectNoExecutionListeners, gateTermination } from "./support/worker-cleanup.ts";

describe("CodeExecutor outcome ownership", () => {
  test("preserves a setup exception when registration also emits a worker error", async () => {
    const failure = new Error("Listener setup failed");
    let observed = false;
    const workers: Worker[] = [];
    using registration = spyOn(Worker.prototype, "on");
    const on = registration.getMockImplementation();
    if (on === undefined) throw new Error("Expected native listener registration");

    registration.mockImplementation(function (this: Worker, ...args: Parameters<Worker["on"]>) {
      const result = on.apply(this, args);
      if (args[0] === "message") {
        workers.push(this);
        observed = this.emit("error", new Error("Private registration failure"));
        throw failure;
      }

      return result;
    });

    const error = await executionErrorOf(new CodeExecutor().execute("return 42;"));

    expect(error.cause).toBe(failure);
    expect(observed).toBe(true);
    expect(workers).toHaveLength(1);
    for (const worker of workers) expectNoExecutionListeners(worker);

    expect(registration).toHaveBeenCalledWith("message", expect.any(Function));
  });

  test("preserves a setup exception when termination emits a late worker error", async () => {
    const failure = new Error("Listener setup failed");
    let observed = false;
    const workers: Worker[] = [];
    using registration = spyOn(Worker.prototype, "on");
    const on = registration.getMockImplementation();
    if (on === undefined) throw new Error("Expected native listener registration");

    registration.mockImplementation(function (this: Worker, ...args: Parameters<Worker["on"]>) {
      const result = on.apply(this, args);
      if (args[0] === "message") {
        workers.push(this);
        throw failure;
      }

      return result;
    });
    using termination = spyOn(Worker.prototype, "terminate");
    const terminateWorker = termination.getMockImplementation();
    if (terminateWorker === undefined) throw new Error("Expected native termination");

    termination.mockImplementation(async function (this: Worker) {
      observed = this.emit("error", new Error("Private late failure"));

      return await terminateWorker.call(this);
    });

    const error = await executionErrorOf(new CodeExecutor().execute("return 42;"));

    expect(error.cause).toBe(failure);
    expect(observed).toBe(true);
    expect(termination).toHaveBeenCalledTimes(1);
    expect(workers).toHaveLength(1);
    for (const worker of workers) expectNoExecutionListeners(worker);

    expect(registration).toHaveBeenCalledWith("message", expect.any(Function));
  });

  test("closes in-flight calls before aborting tools after listener setup fails", async () => {
    const failure = new Error("Listener setup failed");
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));
    const workers: Worker[] = [];
    let aborted = false;
    let calls = 0;
    let conversions = 0;
    using registration = spyOn(Worker.prototype, "on");
    const on = registration.getMockImplementation();
    if (on === undefined) throw new Error("Expected native listener registration");

    registration.mockImplementation(function (this: Worker, ...args: Parameters<Worker["on"]>) {
      const result = on.apply(this, args);
      if (args[0] === "exit") {
        workers.push(this);
        this.emit("message", { type: "tool-call", callId: 1, name: "read", argsJson: undefined });
        throw failure;
      }

      return result;
    });

    const sandbox = new CodeExecutor({
      tools: {
        read: (_args, { signal }) => {
          calls++;
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              for (const worker of workers) {
                worker.emit("message", {
                  type: "tool-call",
                  callId: 2,
                  name: "read",
                  argsJson: undefined,
                });
              }

              late.resolve(
                ToolResult.success({
                  toJSON() {
                    conversions++;

                    return 42;
                  },
                }),
              );
            },
            { once: true },
          );

          return late.promise;
        },
      },
    });

    const error = await executionErrorOf(sandbox.execute("return 42;"));

    expect(error.cause).toBe(failure);
    expect(error.calls).toEqual([
      { callId: 1, name: "read", status: "interrupted", reason: "sandbox-error" },
    ]);
    expect(aborted).toBe(true);
    expect(calls).toBe(1);
    expect(conversions).toBe(0);
    expect(workers).toHaveLength(1);
    for (const worker of workers) expectNoExecutionListeners(worker);

    expect(registration).toHaveBeenCalledWith("exit", expect.any(Function));
  });

  test("retains worker failure when the caller cancels afterward", async () => {
    using captured = captureWorker();
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));

    const sandbox = new CodeExecutor({
      tools: {
        first: () => ToolResult.success(42),
        wait: () => {
          started.resolve();

          return late.promise;
        },
      },
    });

    const completion = executionErrorOf(
      sandbox.execute("await tools.first(); return await tools.wait();", {
        signal: controller.signal,
      }),
    );

    const worker = await captured.worker;
    await started.promise;

    worker.emit("error", new Error("Private worker details"));
    controller.abort();
    const error = await completion;

    expect(error.cause).toEqual(
      new Error("Sandbox worker failed. Internal error details are not transferred."),
    );
    expect(error.calls).toEqual([
      { callId: 1, name: "first", status: "completed" },
      { callId: 2, name: "wait", status: "interrupted", reason: "sandbox-error" },
    ]);
    expectNoExecutionListeners(worker, controller.signal);
  });

  test("keeps success fixed when cancellation and expiry arrive during cleanup", async () => {
    using captured = captureWorker();
    const controller = new AbortController();
    const now = performance.now();
    using clock = spyOn(performance, "now").mockReturnValue(now);
    const sandbox = new CodeExecutor({ totalTimeoutMs: 10_000 });
    let settled = false;

    const completion = sandbox
      .execute("return 42;", { signal: controller.signal })
      .then((report) => {
        settled = true;

        return report;
      });

    const worker = await captured.worker;
    using termination = gateTermination(worker);

    await termination.terminating;
    expect(settled).toBe(false);
    clock.mockReturnValue(now + 10_001);
    controller.abort();
    worker.emit("message", { type: "completed", result: { ok: true, value: 7 } });
    worker.emit("error", new Error("Private late worker failure"));
    termination.release();
    const report = await completion;

    expect(report).toEqual({ result: { ok: true, value: 42 }, calls: [] });
    expect(termination.terminate).toHaveBeenCalledTimes(1);
    expectNoExecutionListeners(worker, controller.signal);
  });

  test("keeps timeout fixed when cancellation arrives after deadline selection", async () => {
    using captured = captureWorker();
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));
    const now = performance.now();
    using clock = spyOn(performance, "now").mockReturnValue(now);

    const sandbox = new CodeExecutor({
      totalTimeoutMs: 10_000,
      tools: {
        first: () => ToolResult.success(42),
        wait: () => {
          started.resolve();

          return late.promise;
        },
      },
    });

    const completion = sandbox.execute("await tools.first(); return await tools.wait();", {
      signal: controller.signal,
    });

    const worker = await captured.worker;
    await started.promise;

    clock.mockReturnValue(now + 10_001);
    worker.emit("message", { type: "completed", result: { ok: true, value: 7 } });
    controller.abort();
    const report = await completion;

    expect(report).toEqual({
      result: {
        ok: false,
        error: { kind: "timeout", message: "Execution exceeded the 10000 ms total limit." },
      },
      calls: [
        { callId: 1, name: "first", status: "completed" },
        { callId: 2, name: "wait", status: "interrupted", reason: "timeout" },
      ],
    });
  });

  test("keeps cancellation fixed through late responses and held termination", async () => {
    using captured = captureWorker();
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));
    let conversions = 0;
    let settled = false;

    const sandbox = new CodeExecutor({
      tools: {
        read: () => {
          started.resolve();

          return late.promise;
        },
      },
    });

    const completion = sandbox
      .execute("return await tools.read();", { signal: controller.signal })
      .then((report) => {
        settled = true;

        return report;
      });

    const worker = await captured.worker;
    using termination = gateTermination(worker);
    using post = spyOn(worker, "postMessage");
    await started.promise;

    controller.abort();
    await termination.terminating;
    expect(settled).toBe(false);
    worker.emit("message", { type: "completed", result: { ok: true, value: 7 } });
    worker.emit("error", new Error("Private late worker failure"));
    late.resolve(
      ToolResult.success({
        toJSON() {
          conversions++;

          return 42;
        },
      }),
    );
    await Bun.sleep(0);
    termination.release();
    const report = await completion;

    expect(report).toEqual({
      result: { ok: false, error: { kind: "cancelled", message: "Execution cancelled." } },
      calls: [{ callId: 1, name: "read", status: "interrupted", reason: "cancelled" }],
    });
    expect(conversions).toBe(0);
    expect(post).not.toHaveBeenCalled();
    expect(termination.terminate).toHaveBeenCalledTimes(1);
    expectNoExecutionListeners(worker, controller.signal);
  });

  test("retains cancellation observations when termination rejects", async () => {
    using captured = captureWorker();
    const controller = new AbortController();
    const cause = new Error("Termination failed");
    const started = Promise.withResolvers<void>();
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));

    const sandbox = new CodeExecutor({
      tools: {
        first: () => ToolResult.success(42),
        wait: () => {
          started.resolve();

          return late.promise;
        },
      },
    });

    const completion = executionErrorOf(
      sandbox.execute("await tools.first(); return await tools.wait();", {
        signal: controller.signal,
      }),
    );

    const worker = await captured.worker;
    const terminateWorker = worker.terminate.bind(worker);

    using terminate = spyOn(worker, "terminate").mockImplementation(async () => {
      await terminateWorker();
      throw cause;
    });

    await started.promise;

    controller.abort();
    const error = await completion;

    expect(error.cause).toBe(cause);
    expect(error.calls).toEqual([
      { callId: 1, name: "first", status: "completed" },
      { callId: 2, name: "wait", status: "interrupted", reason: "cancelled" },
    ]);
    expect(terminate).toHaveBeenCalledTimes(1);
    expectNoExecutionListeners(worker, controller.signal);
  });

  test.each([
    [
      "output-limit",
      {
        kind: "limit",
        resource: "output",
        maximum: 1,
        message: "Output exceeds the 1 byte limit.",
      },
    ],
    ["timeout", { kind: "timeout", message: "Execution exceeded the 100 ms limit." }],
  ] as const)("preserves the %s snapshot when cleanup rejects", async (reason, error) => {
    using captured = captureWorker();
    const cause = new Error("Termination failed");
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));
    const sandbox = new CodeExecutor({ tools: { read: () => late.promise } });
    const completion = executionErrorOf(sandbox.execute("return 42;"));
    const worker = await captured.worker;
    const terminateWorker = worker.terminate.bind(worker);

    using terminate = spyOn(worker, "terminate").mockImplementation(async () => {
      await terminateWorker();
      throw cause;
    });

    worker.emit("message", { type: "tool-call", callId: 1, name: "read", argsJson: undefined });
    worker.emit("message", { type: "completed", result: { ok: false, error } });
    const failure = await completion;

    expect(failure.cause).toBe(cause);
    expect(failure.calls).toEqual([{ callId: 1, name: "read", status: "interrupted", reason }]);
    expect(terminate).toHaveBeenCalledTimes(1);
    expectNoExecutionListeners(worker);
  });

  test("preserves execution and cleanup failures with interrupted calls", async () => {
    using captured = captureWorker();
    const cleanupFailure = new Error("Termination failed");
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));
    const sandbox = new CodeExecutor({ tools: { read: () => late.promise } });
    const completion = executionErrorOf(sandbox.execute("return 42;"));
    const worker = await captured.worker;
    const terminateWorker = worker.terminate.bind(worker);

    using terminate = spyOn(worker, "terminate").mockImplementation(async () => {
      await terminateWorker();
      throw cleanupFailure;
    });

    worker.emit("message", { type: "tool-call", callId: 1, name: "read", argsJson: undefined });
    worker.emit("error", new Error("Private worker details"));
    const error = await completion;

    expect(error.calls).toEqual([
      { callId: 1, name: "read", status: "interrupted", reason: "sandbox-error" },
    ]);
    expect(error.cause).toBeInstanceOf(SuppressedError);
    if (!(error.cause instanceof SuppressedError)) throw new Error("Expected both failures");

    expect(error.cause.error).toBe(cleanupFailure);
    expect(error.cause.suppressed).toEqual(
      new Error("Sandbox worker failed. Internal error details are not transferred."),
    );
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  test("closes dispatch before notifying reentrant tool-abort listeners", async () => {
    using captured = captureWorker();
    const controller = new AbortController();
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));
    const started = Promise.withResolvers<void>();
    let calls = 0;
    let conversions = 0;

    const sandbox = new CodeExecutor({
      tools: {
        read: (_args, { signal }) => {
          calls++;

          const abort = () => {
            late.resolve(
              ToolResult.success({
                toJSON() {
                  conversions++;

                  return 42;
                },
              }),
            );
            worker.emit("message", {
              type: "tool-call",
              callId: 2,
              name: "read",
              argsJson: undefined,
            });
            worker.emit("message", { type: "completed", result: { ok: true, value: 42 } });
          };

          signal.addEventListener("abort", abort, { once: true });
          started.resolve();

          return late.promise;
        },
      },
    });

    const completion = sandbox.execute("return await tools.read();", { signal: controller.signal });
    const worker = await captured.worker;
    using post = spyOn(worker, "postMessage");
    await started.promise;

    controller.abort();
    const report = await completion;

    expect(report).toEqual({
      result: { ok: false, error: { kind: "cancelled", message: "Execution cancelled." } },
      calls: [{ callId: 1, name: "read", status: "interrupted", reason: "cancelled" }],
    });
    expect(calls).toBe(1);
    expect(conversions).toBe(0);
    expect(post).not.toHaveBeenCalled();
    expectNoExecutionListeners(worker, controller.signal);
  });

  test("counts listener setup time against the total deadline", async () => {
    const now = performance.now();
    using clock = spyOn(performance, "now").mockReturnValue(now);
    const workers: Worker[] = [];
    using registration = spyOn(Worker.prototype, "on");
    const on = registration.getMockImplementation();
    if (on === undefined) throw new Error("Expected native listener registration");

    registration.mockImplementation(function (this: Worker, ...args: Parameters<Worker["on"]>) {
      const result = on.apply(this, args);
      if (args[0] === "message") {
        workers.push(this);
        clock.mockReturnValue(now + 101);
      }

      return result;
    });

    const report = await new CodeExecutor({ totalTimeoutMs: 100 }).execute("return 42;");

    expect(report).toEqual({
      result: {
        ok: false,
        error: { kind: "timeout", message: "Execution exceeded the 100 ms total limit." },
      },
      calls: [],
    });
    expect(workers).toHaveLength(1);
    for (const worker of workers) expectNoExecutionListeners(worker);

    expect(registration).toHaveBeenCalled();
  });
});
