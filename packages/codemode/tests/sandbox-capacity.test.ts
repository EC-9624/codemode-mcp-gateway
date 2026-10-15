import { describe, expect, spyOn, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { CodeExecutor, ToolResult } from "@cmg/codemode";
import { captureWorker } from "./support/capture-worker.ts";
import { executionErrorOf } from "./support/execution-error.ts";
import { gateTermination } from "./support/worker-cleanup.ts";

describe("CodeExecutor execution capacity", () => {
  test("holds admission across per-execution tool snapshots until worker cleanup completes", async () => {
    using captured = captureWorker();
    const sandbox = new CodeExecutor({ maxConcurrentExecutions: 1 });
    const oldTools = { value: () => ToolResult.success("old") };
    const currentTools = { value: () => ToolResult.success("current") };

    const running = sandbox.execute("return await tools.value();", { tools: oldTools });
    const worker = await captured.worker;
    using termination = gateTermination(worker);
    await termination.terminating;

    let reads = 0;

    const rejected = await sandbox.execute("return await tools.value();", {
      get tools() {
        reads++;

        return currentTools;
      },
    });

    termination.release();
    const previous = await running;
    const recovered = await sandbox.execute("return await tools.value();", { tools: currentTools });

    expect(rejected).toMatchObject({
      result: { ok: false, error: { kind: "limit", resource: "executions", maximum: 1 } },
      calls: [],
    });
    expect(previous.result).toEqual({ ok: true, value: "old" });
    expect(recovered.result).toEqual({ ok: true, value: "current" });
    expect(reads).toBe(0);
  });

  test("admits four executions by default and rejects the fifth without creating a worker or dispatching a tool", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => release.resolve());
    let calls = 0;

    const sandbox = new CodeExecutor({
      tools: {
        wait: async () => {
          if (++calls === 4) started.resolve();

          await release.promise;

          return ToolResult.success(42);
        },
      },
    });

    const running = Array.from({ length: 4 }, () => sandbox.execute("return await tools.wait();"));
    await started.promise;
    using registration = spyOn(Worker.prototype, "on");

    const rejected = await sandbox.execute("return await tools.wait();");

    expect(rejected).toEqual({
      result: {
        ok: false,
        error: {
          kind: "limit",
          resource: "executions",
          maximum: 4,
          message: "Executor reached the 4 concurrent-execution limit.",
        },
      },
      calls: [],
    });
    expect(registration).not.toHaveBeenCalled();
    expect(calls).toBe(4);
    release.resolve();
    const reports = await Promise.all(running);
    expect(reports.map((report) => report.result)).toEqual(
      Array.from({ length: 4 }, () => ({ ok: true, value: 42 })),
    );
    expect(calls).toBe(4);
  });

  test("snapshots a configured capacity greater than the default", async () => {
    const release = Promise.withResolvers<void>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => release.resolve());

    const options = {
      maxConcurrentExecutions: 5,
      tools: {
        wait: async () => {
          await release.promise;

          return ToolResult.success(42);
        },
      },
    };

    const sandbox = new CodeExecutor(options);
    options.maxConcurrentExecutions = 1;

    const running = Array.from({ length: 5 }, () => sandbox.execute("return await tools.wait();"));
    release.resolve();
    const reports = await Promise.all(running);

    expect(reports.map((report) => report.result)).toEqual(
      Array.from({ length: 5 }, () => ({ ok: true, value: 42 })),
    );
  });

  test("a full executor does not consume another executor's capacity", async () => {
    const release = Promise.withResolvers<void>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => release.resolve());

    const first = new CodeExecutor({
      maxConcurrentExecutions: 1,
      tools: {
        wait: async () => {
          await release.promise;

          return ToolResult.success(42);
        },
      },
    });

    const second = new CodeExecutor({ maxConcurrentExecutions: 1 });
    const running = first.execute("return await tools.wait();");

    const independent = await second.execute("return 7;");

    expect(independent).toEqual({ result: { ok: true, value: 7 }, calls: [] });
    release.resolve();
    await running;
  });

  test.each([
    {
      name: "pre-aborted",
      code: "return 42;",
      signal: AbortSignal.abort(),
      expected: {
        result: { ok: false, error: { kind: "cancelled", message: "Execution cancelled." } },
        calls: [],
      },
    },
    {
      name: "oversized",
      code: "x".repeat(101),
      signal: undefined,
      expected: {
        result: {
          ok: false,
          error: {
            kind: "limit",
            resource: "source",
            maximum: 100,
            message: "Source exceeds the 100 byte limit.",
          },
        },
        calls: [],
      },
    },
  ])("handles a $name submission before capacity admission", async ({ code, signal, expected }) => {
    const release = Promise.withResolvers<void>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => release.resolve());

    const sandbox = new CodeExecutor({
      maxConcurrentExecutions: 1,
      maxSourceBytes: 100,
      tools: {
        wait: async () => {
          await release.promise;

          return ToolResult.success(42);
        },
      },
    });

    const running = sandbox.execute("return await tools.wait();");

    let reads = 0;

    const rejected = await sandbox.execute(code, {
      ...(signal === undefined ? {} : { signal }),
      get tools() {
        reads++;

        return {};
      },
    });

    const stillFull = await sandbox.execute("return 7;");
    release.resolve();
    await running;
    const recovered = await sandbox.execute("return 7;");

    expect(rejected).toEqual(expected);
    expect(reads).toBe(0);
    expect(stillFull).toMatchObject({
      result: { ok: false, error: { kind: "limit", resource: "executions" } },
      calls: [],
    });
    expect(recovered).toEqual({ result: { ok: true, value: 7 }, calls: [] });
  });

  test("holds capacity until successful execution cleanup settles, even after actual worker exit", async () => {
    using captured = captureWorker();
    const sandbox = new CodeExecutor({ maxConcurrentExecutions: 1 });
    const running = sandbox.execute("return 42;");
    const worker = await captured.worker;
    using termination = gateTermination(worker);
    await termination.terminating;

    const rejected = await sandbox.execute("return 7;");
    termination.release();
    await running;
    const recovered = await sandbox.execute("return 7;");

    expect(rejected).toMatchObject({
      result: { ok: false, error: { kind: "limit", resource: "executions", maximum: 1 } },
      calls: [],
    });
    expect(recovered).toEqual({ result: { ok: true, value: 7 }, calls: [] });
  });

  test("cancellation frees capacity after worker cleanup without waiting for an uncooperative tool", async () => {
    using captured = captureWorker();
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));

    const sandbox = new CodeExecutor({
      maxConcurrentExecutions: 1,
      tools: {
        wait: () => {
          started.resolve();

          return late.promise;
        },
      },
    });

    const running = sandbox.execute("return await tools.wait();", { signal: controller.signal });
    const worker = await captured.worker;
    using termination = gateTermination(worker);
    await started.promise;

    controller.abort();
    await termination.terminating;
    const rejected = await sandbox.execute("return 7;");
    termination.release();
    const cancelled = await running;
    const recovered = await sandbox.execute("return 7;");

    expect(rejected).toMatchObject({
      result: { ok: false, error: { kind: "limit", resource: "executions" } },
    });
    expect(cancelled.result).toEqual({
      ok: false,
      error: { kind: "cancelled", message: "Execution cancelled." },
    });
    expect(recovered).toEqual({ result: { ok: true, value: 7 }, calls: [] });
  });

  test.each([
    { name: "script failure", code: 'throw new Error("failure");', kind: "script" },
    { name: "deadline", code: "while (true) {}", kind: "timeout" },
  ])("releases capacity after a $name", async ({ code, kind }) => {
    const sandbox = new CodeExecutor({ maxConcurrentExecutions: 1, timeoutMs: 100 });

    const failed = await sandbox.execute(code);
    const recovered = await sandbox.execute("return 42;");

    expect(failed.result).toMatchObject({ ok: false, error: { kind } });
    expect(recovered).toEqual({ result: { ok: true, value: 42 }, calls: [] });
  });

  test("releases the reservation when worker startup construction fails", async () => {
    const sandbox = new CodeExecutor({ maxConcurrentExecutions: 1 });
    const cause = new Error("Worker URL construction failed");
    // No public worker factory exists; fail the URL dependency inside the construction boundary.
    const NativeURL = globalThis.URL;
    using cleanup = new DisposableStack();
    cleanup.defer(() => {
      globalThis.URL = NativeURL;
    });
    globalThis.URL = class extends NativeURL {
      constructor(...args: ConstructorParameters<typeof URL>) {
        super(...args);
        throw cause;
      }
    };

    const failed = await executionErrorOf(sandbox.execute("return 42;"));
    globalThis.URL = NativeURL;
    const recovered = await sandbox.execute("return 7;");

    expect(failed.cause).toBe(cause);
    expect(failed.calls).toEqual([]);
    expect(recovered).toEqual({ result: { ok: true, value: 7 }, calls: [] });
  });

  test("keeps capacity reserved across tool snapshots after termination failure until actual exit", async () => {
    using captured = captureWorker();
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));

    const sandbox = new CodeExecutor({
      maxConcurrentExecutions: 1,
      timeoutMs: 10_000,
      tools: {
        wait: () => {
          started.resolve();

          return late.promise;
        },
      },
    });

    const running = executionErrorOf(
      sandbox.execute("return await tools.wait();", { signal: controller.signal }),
    );

    const worker = await captured.worker;
    const terminateWorker = worker.terminate.bind(worker);
    await using workerCleanup = new AsyncDisposableStack();
    workerCleanup.defer(async () => {
      await terminateWorker();
    });
    const cause = new Error("Worker termination failed");
    using terminate = spyOn(worker, "terminate").mockRejectedValue(cause);
    await started.promise;

    controller.abort();
    const failed = await running;
    const rejected = await sandbox.execute("return 7;", { tools: {} });

    expect(failed.cause).toBe(cause);
    expect(worker.threadId).not.toBe(-1);
    expect(rejected).toMatchObject({
      result: { ok: false, error: { kind: "limit", resource: "executions", maximum: 1 } },
      calls: [],
    });
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(worker.listenerCount("error")).toBeGreaterThan(0);
    expect(() => worker.emit("error", new Error("Late private worker failure"))).not.toThrow();

    await terminateWorker();
    const recovered = await sandbox.execute("return 7;", { tools: {} });

    expect(worker.listenerCount("exit")).toBe(0);
    expect(worker.listenerCount("error")).toBe(0);
    expect(recovered).toEqual({ result: { ok: true, value: 7 }, calls: [] });
  });
});
