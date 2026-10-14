import { describe, expect, spyOn, test } from "bun:test";
import { ToolResult } from "@cmg/codemode";
import { executionErrorOf } from "./support/execution-error.ts";
import { faultWorker, interruptFlag, superviseWorker, toolWorker } from "./support/workers.ts";
import { expectNoExecutionListeners, gateTermination } from "./support/worker-cleanup.ts";

// Public execution hides worker events and termination. These probes inject races that cannot
// be ordered through guest code: partial setup, reentrant events, held cleanup, and cleanup failure.

describe("parent-owned call outcomes", () => {
  test("retains worker failure and its call snapshot when cancellation arrives afterward", async () => {
    const controller = new AbortController();
    const worker = toolWorker("await tools.read(1); return await tools.read(2);");
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));

    const error = await executionErrorOf(
      superviseWorker(worker, {
        tools: {
          read: (args) => {
            if (args === 1) return ToolResult.success(42);

            worker.emit("error", new Error("Private worker details"));
            controller.abort();

            return late.promise;
          },
        },
        control: { signal: controller.signal, interrupt: interruptFlag() },
      }),
    );

    expect(error.calls).toEqual([
      { callId: 1, name: "read", status: "completed", result: { ok: true, json: "42" } },
      { callId: 2, name: "read", status: "interrupted", reason: "sandbox-error" },
    ]);
    expect(error.cause).toBeInstanceOf(Error);
    if (error.cause instanceof Error) {
      expect(error.cause.message).toBe(
        "Sandbox worker failed. Internal error details are not transferred.",
      );
      expect(error.cause.cause).toBeUndefined();
    }

    expectNoExecutionListeners(worker, controller.signal);
  });

  test("closes in-flight calls before aborting tools when listener setup fails", async () => {
    const worker = faultWorker("idle");
    const failure = new Error("Listener setup failed");
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));
    const addListener = worker.on.bind(worker);
    let aborted = false;
    let invocations = 0;
    let conversions = 0;

    using add = spyOn(worker, "on").mockImplementation((...args: Parameters<typeof worker.on>) => {
      const added = addListener(...args);
      if (args[0] === "exit") {
        worker.emit("message", { type: "tool-call", callId: 1, name: "read", argsJson: undefined });
        throw failure;
      }

      return added;
    });

    const error = await executionErrorOf(
      superviseWorker(worker, {
        tools: {
          read: (_args, { signal }) => {
            invocations++;
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                worker.emit("message", {
                  type: "tool-call",
                  callId: 2,
                  name: "read",
                  argsJson: undefined,
                });
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
      }),
    );

    expect(error.cause).toBe(failure);
    expect(error.calls).toEqual([
      { callId: 1, name: "read", status: "interrupted", reason: "sandbox-error" },
    ]);
    expect(aborted).toBe(true);
    expect(invocations).toBe(1);
    expect(conversions).toBe(0);
    expect(add).toHaveBeenCalled();
    expectNoExecutionListeners(worker);
  });

  test("keeps the timeout interruption reason when cancellation arrives after deadline selection", async () => {
    const controller = new AbortController();

    const control = {
      deadline: { timeoutMs: 10000, expiresAt: performance.now() + 10000 },
      interrupt: interruptFlag(),
      signal: controller.signal,
    };

    const worker = toolWorker(
      "await tools.read(1); return await tools.read(2);",
      10000,
      control.interrupt.buffer,
    );

    const started = Promise.withResolvers<void>();
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));

    const completion = superviseWorker(worker, {
      tools: {
        read: (args) => {
          if (args === 1) return ToolResult.success(42);

          started.resolve();

          return late.promise;
        },
      },
      control,
    });

    await started.promise;
    control.deadline.expiresAt = performance.now() + 20;
    // Expire the clock while deliberately preventing the parent timer callback from running.
    Bun.sleepSync(40);
    worker.emit("message", { type: "completed", result: { ok: true, value: 7 } });
    controller.abort();

    expect(await completion).toEqual({
      result: {
        ok: false,
        error: { kind: "timeout", message: "Execution exceeded the 10000 ms total limit." },
      },
      calls: [
        { callId: 1, name: "read", status: "completed", result: { ok: true, json: "42" } },
        { callId: 2, name: "read", status: "interrupted", reason: "timeout" },
      ],
    });
  });

  test("keeps cancellation and its snapshot fixed through late events and held termination", async () => {
    const controller = new AbortController();
    const worker = toolWorker("return await tools.read();");
    using termination = gateTermination(worker);
    const started = Promise.withResolvers<void>();
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));
    let conversions = 0;
    let settled = false;

    const control = {
      signal: controller.signal,
      interrupt: interruptFlag(),
      deadline: { timeoutMs: 10000, expiresAt: performance.now() + 10000 },
    };

    using post = spyOn(worker, "postMessage");

    const completion = superviseWorker(worker, {
      tools: {
        read: () => {
          started.resolve();

          return late.promise;
        },
      },
      control,
    }).then((report) => {
      settled = true;

      return report;
    });

    await started.promise;
    controller.abort();
    await termination.terminating;
    expect(settled).toBe(false);
    expect(Atomics.load(control.interrupt, 0)).toBe(1);
    control.deadline.expiresAt = performance.now() - 1;
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

    expect(await completion).toEqual({
      result: { ok: false, error: { kind: "cancelled", message: "Execution cancelled." } },
      calls: [{ callId: 1, name: "read", status: "interrupted", reason: "cancelled" }],
    });
    expect(conversions).toBe(0);
    expect(post).not.toHaveBeenCalled();
    expect(termination.terminate).toHaveBeenCalledTimes(1);
    expectNoExecutionListeners(worker, controller.signal);
  });

  test("retains the cancellation snapshot when worker termination rejects", async () => {
    const controller = new AbortController();
    const worker = toolWorker("await tools.read(1); return await tools.read(2);");
    const terminateWorker = worker.terminate.bind(worker);
    const cause = new Error("Termination failed");
    const started = Promise.withResolvers<void>();
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));

    using terminate = spyOn(worker, "terminate").mockImplementation(async () => {
      await terminateWorker();
      throw cause;
    });

    const completion = superviseWorker(worker, {
      tools: {
        read: (args) => {
          if (args === 1) return ToolResult.success(42);

          started.resolve();

          return late.promise;
        },
      },
      control: { signal: controller.signal, interrupt: interruptFlag() },
    });

    await started.promise;
    controller.abort();
    const error = await executionErrorOf(completion);

    expect(error.cause).toBe(cause);
    expect(error.calls).toEqual([
      { callId: 1, name: "read", status: "completed", result: { ok: true, json: "42" } },
      { callId: 2, name: "read", status: "interrupted", reason: "cancelled" },
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
    const worker = faultWorker("idle");
    const terminateWorker = worker.terminate.bind(worker);
    const cause = new Error("Termination failed");
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));

    using terminate = spyOn(worker, "terminate").mockImplementation(async () => {
      await terminateWorker();
      throw cause;
    });

    const completion = superviseWorker(worker, { tools: { read: () => late.promise } });

    worker.emit("message", { type: "tool-call", callId: 1, name: "read", argsJson: undefined });
    worker.emit("message", {
      type: "completed",
      result: {
        ok: false,
        error: {
          ...error,
        },
      },
    });
    const failure = await executionErrorOf(completion);

    expect(failure.cause).toBe(cause);
    expect(failure.calls).toEqual([{ callId: 1, name: "read", status: "interrupted", reason }]);
    expect(terminate).toHaveBeenCalledTimes(1);
    expectNoExecutionListeners(worker);
  });

  test("preserves both execution and cleanup failures alongside sandbox-interrupted calls", async () => {
    const worker = faultWorker("idle");
    const terminateWorker = worker.terminate.bind(worker);
    const cleanupFailure = new Error("Termination failed");
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));

    using terminate = spyOn(worker, "terminate").mockImplementation(async () => {
      await terminateWorker();
      throw cleanupFailure;
    });

    const completion = superviseWorker(worker, { tools: { read: () => late.promise } });

    worker.emit("message", { type: "tool-call", callId: 1, name: "read", argsJson: undefined });
    worker.emit("error", new Error("Private worker details"));
    const error = await executionErrorOf(completion);

    expect(error.calls).toEqual([
      { callId: 1, name: "read", status: "interrupted", reason: "sandbox-error" },
    ]);
    expect(error.cause).toBeInstanceOf(SuppressedError);
    if (error.cause instanceof SuppressedError) {
      expect(error.cause.error).toBe(cleanupFailure);
      expect(error.cause.suppressed).toBeInstanceOf(Error);
      if (error.cause.suppressed instanceof Error) {
        expect(error.cause.suppressed.message).toBe(
          "Sandbox worker failed. Internal error details are not transferred.",
        );
      }
    }

    expect(terminate).toHaveBeenCalledTimes(1);
  });
});

test("fixes the outcome before reentrant tool-abort listeners emit new worker events", async () => {
  const controller = new AbortController();
  const worker = faultWorker("idle");
  const late = Promise.withResolvers<ToolResult>();
  using cleanup = new DisposableStack();
  cleanup.defer(() => late.resolve(ToolResult.success()));
  const request = { type: "tool-call", callId: 1, name: "read", argsJson: undefined };
  let calls = 0;
  let conversions = 0;
  using post = spyOn(worker, "postMessage");

  const completion = superviseWorker(worker, {
    control: { signal: controller.signal, interrupt: interruptFlag() },
    tools: {
      read: (_args, { signal }) => {
        calls++;
        signal.addEventListener(
          "abort",
          () => {
            late.resolve(
              ToolResult.success({
                toJSON() {
                  conversions++;

                  return 42;
                },
              }),
            );
            worker.emit("message", { ...request, callId: 2 });
            worker.emit("message", { type: "completed", result: { ok: true, value: 42 } });
          },
          { once: true },
        );

        return late.promise;
      },
    },
  });

  worker.emit("message", request);
  controller.abort();

  expect(await completion).toEqual({
    result: { ok: false, error: { kind: "cancelled", message: "Execution cancelled." } },
    calls: [{ callId: 1, name: "read", status: "interrupted", reason: "cancelled" }],
  });
  expect(calls).toBe(1);
  expect(conversions).toBe(0);
  expect(post).not.toHaveBeenCalled();
  expectNoExecutionListeners(worker, controller.signal);
});

test("cancellation releases a worker stalled during startup", async () => {
  const controller = new AbortController();
  const control = { signal: controller.signal, interrupt: interruptFlag() };
  const worker = faultWorker("startup-stall");
  using terminate = spyOn(worker, "terminate");
  const completion = superviseWorker(worker, { control });

  controller.abort();

  expect((await completion).result).toEqual({
    ok: false,
    error: { kind: "cancelled", message: "Execution cancelled." },
  });
  expect(Atomics.load(control.interrupt, 0)).toBe(1);
  expect(terminate).toHaveBeenCalledTimes(1);
  expectNoExecutionListeners(worker, controller.signal);
});

test("the total deadline releases stalled startup and awaits termination", async () => {
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

  expect((await completion).result).toEqual({
    ok: false,
    error: { kind: "timeout", message: "Execution exceeded the 20 ms total limit." },
  });
  expect(termination.terminate).toHaveBeenCalledTimes(1);
  expectNoExecutionListeners(worker);
});

test("counts time elapsed before the supervisor takes ownership", async () => {
  const worker = faultWorker("idle");

  const control = {
    deadline: { timeoutMs: 100, expiresAt: performance.now() - 1 },
    interrupt: interruptFlag(),
  };

  const report = await superviseWorker(worker, { control });

  expect(report).toEqual({
    result: {
      ok: false,
      error: { kind: "timeout", message: "Execution exceeded the 100 ms total limit." },
    },
    calls: [],
  });
  expect(Atomics.load(control.interrupt, 0)).toBe(1);
  expectNoExecutionListeners(worker);
});
