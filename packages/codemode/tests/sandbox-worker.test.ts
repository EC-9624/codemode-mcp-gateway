import { describe, expect, spyOn, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { CodeExecutor, SandboxExecutionError, ToolResult } from "@cmg/codemode";
import { captureWorker } from "./support/capture-worker.ts";
import { executionErrorOf } from "./support/execution-error.ts";
import { expectNoExecutionListeners, gateTermination } from "./support/worker-cleanup.ts";

describe("CodeExecutor worker failures", () => {
  test("enforces total calls even when the worker sends requests beyond its budget", async () => {
    using captured = captureWorker();
    let calls = 0;

    const sandbox = new CodeExecutor({
      tools: { read: () => ToolResult.success(++calls) },
      maxToolCalls: 2,
    });

    const completion = sandbox.execute("return 42;");
    const worker = await captured.worker;
    const firstReply = Promise.withResolvers<void>();
    const secondReply = Promise.withResolvers<void>();
    let replies = 0;

    using post = spyOn(worker, "postMessage").mockImplementation(() => {
      replies++;
      if (replies === 1) firstReply.resolve();

      if (replies === 2) secondReply.resolve();
    });

    worker.emit("message", { type: "tool-call", callId: 1, name: "read", argsJson: undefined });
    await firstReply.promise;
    worker.emit("message", { type: "tool-call", callId: 2, name: "read", argsJson: undefined });
    await secondReply.promise;
    worker.emit("message", { type: "tool-call", callId: 3, name: "read", argsJson: undefined });
    const report = await completion;

    expect(report).toEqual({
      result: {
        ok: false,
        error: {
          kind: "limit",
          resource: "tool-calls",
          maximum: 2,
          message: "Execution exceeded the 2 tool-call limit.",
        },
      },
      calls: [
        { callId: 1, name: "read", status: "completed" },
        { callId: 2, name: "read", status: "completed" },
      ],
    });
    expect(calls).toBe(2);
    expect(post).toHaveBeenCalledTimes(2);
  });

  test("enforces host concurrency independently and discards late responses", async () => {
    using captured = captureWorker();
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));
    const signals: AbortSignal[] = [];
    let conversions = 0;

    const sandbox = new CodeExecutor({
      maxConcurrentToolCalls: 1,
      tools: {
        read: (_args, { signal }) => {
          signals.push(signal);

          return late.promise;
        },
      },
    });

    const completion = sandbox.execute("return 42;");
    const worker = await captured.worker;
    using post = spyOn(worker, "postMessage");

    worker.emit("message", { type: "tool-call", callId: 1, name: "read", argsJson: undefined });
    worker.emit("message", { type: "tool-call", callId: 2, name: "read", argsJson: undefined });
    const report = await completion;
    late.resolve(
      ToolResult.success({
        toJSON() {
          conversions++;

          return 42;
        },
      }),
    );
    await Bun.sleep(0);

    expect(report).toEqual({
      result: {
        ok: false,
        error: {
          kind: "limit",
          resource: "concurrent-tool-calls",
          maximum: 1,
          message: "Execution exceeded the 1 concurrent tool-call limit.",
        },
      },
      calls: [{ callId: 1, name: "read", status: "interrupted", reason: "concurrency-limit" }],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(conversions).toBe(0);
    expect(post).not.toHaveBeenCalled();
    expectNoExecutionListeners(worker);
  });

  test("keeps the call-limit interruption reason when termination rejects", async () => {
    using captured = captureWorker();
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));
    const cause = new Error("Termination failed");
    const sandbox = new CodeExecutor({ tools: { read: () => late.promise }, maxToolCalls: 1 });
    const completion = executionErrorOf(sandbox.execute("return 42;"));
    const worker = await captured.worker;
    const terminateWorker = worker.terminate.bind(worker);

    using terminate = spyOn(worker, "terminate").mockImplementation(async () => {
      await terminateWorker();
      throw cause;
    });

    worker.emit("message", { type: "tool-call", callId: 1, name: "read", argsJson: undefined });
    worker.emit("message", { type: "tool-call", callId: 2, name: "read", argsJson: undefined });
    const error = await completion;

    expect(error.cause).toBe(cause);
    expect(error.calls).toEqual([
      { callId: 1, name: "read", status: "interrupted", reason: "call-limit" },
    ]);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  test.each([
    {
      name: "an invalid result",
      message: { type: "completed", result: { ok: false, error: { kind: "unknown" } } },
      expected: "invalid response",
    },
    {
      name: "a rejected startup request",
      message: { type: "failed", reason: "request" },
      expected: "rejected the execution request",
    },
    {
      name: "a worker execution failure",
      message: { type: "failed", reason: "execution" },
      expected: "Sandbox worker execution failed.",
    },
  ])("rejects $name and releases the worker", async ({ message, expected }) => {
    using captured = captureWorker();
    const sandbox = new CodeExecutor();
    const completion = executionErrorOf(sandbox.execute("return 42;"));
    const worker = await captured.worker;
    using terminate = spyOn(worker, "terminate");

    worker.emit("message", message);
    const error = await completion;

    expect(error.cause).toBeInstanceOf(Error);
    if (!(error.cause instanceof Error)) throw new Error("Expected an infrastructure cause");

    expect(error.cause.message).toContain(expected);
    expect(error.calls).toEqual([]);
    expectNoExecutionListeners(worker);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  test("rejects early worker exit instead of returning a script failure", async () => {
    using captured = captureWorker();
    const completion = executionErrorOf(new CodeExecutor().execute("return 42;"));
    const worker = await captured.worker;

    worker.emit("exit", 1);
    const error = await completion;

    expect(error.cause).toEqual(new Error("Sandbox worker closed before completion."));
    expect(error.calls).toEqual([]);
    expectNoExecutionListeners(worker);
  });

  test("keeps worker error details private and permits a subsequent execution", async () => {
    using captured = captureWorker();
    const sandbox = new CodeExecutor({ maxConcurrentExecutions: 1 });
    const completion = executionErrorOf(sandbox.execute("return 42;"));
    const worker = await captured.worker;

    worker.emit("error", new Error("Private worker credentials"));
    const error = await completion;
    const recovered = await sandbox.execute("return 7;");

    expect(error.cause).toEqual(
      new Error("Sandbox worker failed. Internal error details are not transferred."),
    );
    expect(error.calls).toEqual([]);
    expect(recovered).toEqual({ result: { ok: true, value: 7 }, calls: [] });
    expectNoExecutionListeners(worker);
  });

  test("rejects response deserialization failure and removes worker listeners", async () => {
    using captured = captureWorker();
    const completion = executionErrorOf(new CodeExecutor().execute("return 42;"));
    const worker = await captured.worker;
    using terminate = spyOn(worker, "terminate");

    worker.emit("messageerror", new Error("Private deserialization details"));
    const error = await completion;

    expect(error.cause).toEqual(new Error("Sandbox worker response could not be deserialized."));
    expect(terminate).toHaveBeenCalledTimes(1);
    expectNoExecutionListeners(worker);
  });

  test("settles once and keeps an error listener until termination finishes", async () => {
    using captured = captureWorker();
    const completion = new CodeExecutor().execute("return 42;");
    const worker = await captured.worker;
    using termination = gateTermination(worker);

    worker.emit("message", { type: "completed", result: { ok: true, value: 42 } });
    worker.emit("message", { type: "failed", reason: "execution" });
    await termination.terminating;

    expect(worker.listenerCount("message")).toBe(0);
    expect(worker.listenerCount("messageerror")).toBe(0);
    expect(worker.listenerCount("exit")).toBe(0);
    expect(worker.listenerCount("error")).toBeGreaterThan(0);
    worker.emit("error", new Error("Private late worker failure"));
    termination.release();

    expect(await completion).toEqual({ result: { ok: true, value: 42 }, calls: [] });
    expect(termination.terminate).toHaveBeenCalledTimes(1);
    expectNoExecutionListeners(worker);
  });

  test("recovers capacity after unwinding partial listener setup and terminating the worker", async () => {
    const sandbox = new CodeExecutor({ maxConcurrentExecutions: 1 });
    const failure = new Error("Listener setup failed");
    const workers: Worker[] = [];
    using registration = spyOn(Worker.prototype, "on");
    const on = registration.getMockImplementation();
    if (on === undefined) throw new Error("Expected native listener registration");

    registration.mockImplementation(function (this: Worker, ...args: Parameters<Worker["on"]>) {
      const result = on.apply(this, args);
      if (args[0] === "messageerror") {
        workers.push(this);
        throw failure;
      }

      return result;
    });

    const error = await executionErrorOf(sandbox.execute("return 42;"));
    registration.mockRestore();
    const recovered = await sandbox.execute("return 7;");

    expect(error.cause).toBe(failure);
    expect(error.calls).toEqual([]);
    expect(workers).toHaveLength(1);
    for (const worker of workers) expectNoExecutionListeners(worker);

    expect(recovered).toEqual({ result: { ok: true, value: 7 }, calls: [] });
  });

  test("recovers capacity after termination fails following actual exit without retrying cleanup", async () => {
    using captured = captureWorker();
    const sandbox = new CodeExecutor({ maxConcurrentExecutions: 1 });
    const completion = executionErrorOf(sandbox.execute("return 42;"));
    const worker = await captured.worker;
    const terminateWorker = worker.terminate.bind(worker);
    const failure = new Error("Worker termination failed");

    using terminate = spyOn(worker, "terminate").mockImplementation(async () => {
      await terminateWorker();
      throw failure;
    });

    const error = await completion;
    const recovered = await sandbox.execute("return 7;");

    expect(error.cause).toBe(failure);
    expect(terminate).toHaveBeenCalledTimes(1);
    expectNoExecutionListeners(worker);
    expect(recovered).toEqual({ result: { ok: true, value: 7 }, calls: [] });
  });

  test("keeps a completed call summary when reply transport fails without retry", async () => {
    using captured = captureWorker();
    const sandbox = new CodeExecutor({ tools: { read: () => ToolResult.success(42) } });

    const completion = executionErrorOf(
      sandbox.execute('try { return await tools.read(); } catch { return "caught"; }'),
    );

    const worker = await captured.worker;
    const failure = new Error("Private reply transport failure");

    using post = spyOn(worker, "postMessage").mockImplementation(() => {
      throw failure;
    });

    const error = await completion;

    expect(error.cause).toBe(failure);
    expect(error.calls).toEqual([{ callId: 1, name: "read", status: "completed" }]);
    expect(post).toHaveBeenCalledTimes(1);
    expectNoExecutionListeners(worker);
  });

  test.each([
    ["malformed JSON", { type: "tool-result", callId: 1, result: { ok: true, json: "not JSON" } }],
    ["unknown ID", { type: "tool-result", callId: 2, result: { ok: true, json: "42" } }],
    ["missing result field", { type: "tool-result", callId: 1, result: { ok: true } }],
  ] as const)("rejects a reply with %s before guest recovery", async (_name, reply) => {
    using captured = captureWorker();
    const sandbox = new CodeExecutor({ tools: { read: () => ToolResult.success(42) } });

    const completion = executionErrorOf(
      sandbox.execute('try { return await tools.read(); } catch { return "caught"; }'),
    );

    const worker = await captured.worker;
    const send = worker.postMessage.bind(worker);
    using post = spyOn(worker, "postMessage").mockImplementation(() => send(reply));

    const error = await completion;

    expect(error.cause).toEqual(
      new Error("Sandbox worker execution failed. Internal error details are not transferred."),
    );
    expect(post).toHaveBeenCalledTimes(1);
    expectNoExecutionListeners(worker);
  });

  test("rejects duplicate replies while guest jobs keep arriving", async () => {
    using captured = captureWorker();
    const sandbox = new CodeExecutor({ tools: { read: () => ToolResult.success(42) } });

    const completion = executionErrorOf(
      sandbox.execute("tools.read(); while (true) await Promise.resolve();"),
    );

    const worker = await captured.worker;
    const send = worker.postMessage.bind(worker);

    using post = spyOn(worker, "postMessage").mockImplementation((value: unknown) => {
      send(value);
      send(value);
    });

    const error = await completion;

    expect(error.cause).toEqual(
      new Error("Sandbox worker execution failed. Internal error details are not transferred."),
    );
    expect(post).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["unknown tool", { type: "tool-call", callId: 1, name: "toString", argsJson: undefined }],
    [
      "worker execution admission",
      {
        type: "completed",
        result: {
          ok: false,
          error: { kind: "limit", resource: "executions", maximum: 1, message: "forged" },
        },
      },
    ],
    ["malformed arguments", { type: "tool-call", callId: 1, name: "read", argsJson: "not JSON" }],
    ["missing arguments", { type: "tool-call", callId: 1, name: "read" }],
    ["skipped ID", { type: "tool-call", callId: 2, name: "read", argsJson: undefined }],
    [
      "worker cancellation",
      { type: "completed", result: { ok: false, error: { kind: "cancelled", message: "forged" } } },
    ],
    [
      "worker source admission",
      {
        type: "completed",
        result: {
          ok: false,
          error: { kind: "limit", resource: "source", maximum: 1, message: "forged" },
        },
      },
    ],
  ] as const)("rejects %s messages without host dispatch", async (_name, message) => {
    using captured = captureWorker();
    let calls = 0;
    const sandbox = new CodeExecutor({ tools: { read: () => ToolResult.success(++calls) } });
    const completion = executionErrorOf(sandbox.execute("return 42;"));
    const worker = await captured.worker;

    worker.emit("message", message);
    const error = await completion;

    expect(error.cause).toBeInstanceOf(Error);
    expect(error.calls).toEqual([]);
    expect(calls).toBe(0);
    expectNoExecutionListeners(worker);
  });

  test("rejects replayed requests without dispatching twice", async () => {
    using captured = captureWorker();
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));
    let calls = 0;

    const sandbox = new CodeExecutor({
      tools: {
        read: () => {
          calls++;

          return late.promise;
        },
      },
    });

    const completion = executionErrorOf(sandbox.execute("return 42;"));
    const worker = await captured.worker;
    const request = { type: "tool-call", callId: 1, name: "read", argsJson: undefined };

    worker.emit("message", request);
    worker.emit("message", request);
    const error = await completion;

    expect(error.calls).toEqual([
      { callId: 1, name: "read", status: "interrupted", reason: "sandbox-error" },
    ]);
    expect(calls).toBe(1);
  });
});

test("the infrastructure assertion rejects fulfilled Error values", async () => {
  await rejects(executionErrorOf(Promise.resolve(new SandboxExecutionError([], "resolved"))), {
    message: "Expected the operation to reject, but it resolved.",
  });
});
