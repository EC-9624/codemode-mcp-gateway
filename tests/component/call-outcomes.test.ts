import { describe, expect, spyOn, test } from "bun:test";
import { ToolResult } from "../../src/codemode";
import { executionErrorOf } from "../support/execution-error";
import { faultWorker, interruptFlag, superviseWorker, toolWorker } from "../support/workers";
import { expectNoExecutionListeners, gateTermination } from "../support/worker-cleanup";

describe("parent-owned call outcomes", () => {
  test("records dispatch before a callback synchronously cancels execution", async () => {
    const controller = new AbortController();
    const worker = toolWorker("return await tools.read();");

    const report = await superviseWorker(worker, {
      tools: {
        read: () => {
          controller.abort();

          return ToolResult.success(42);
        },
      },
      control: { signal: controller.signal, interrupt: interruptFlag() },
    });

    expect(report).toEqual({
      result: { ok: false, error: { kind: "cancelled", message: "Execution cancelled." } },
      calls: [{ callId: 1, name: "read", status: "interrupted", reason: "cancelled" }],
    });
  });

  test("retains completed and pending calls when the worker fails", async () => {
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

            return late.promise;
          },
        },
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
    control.deadline.expiresAt = performance.now() - 1;
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

  test("does not accept a late response while termination is still pending", async () => {
    const controller = new AbortController();
    const worker = toolWorker("return await tools.read();");
    using termination = gateTermination(worker);
    const started = Promise.withResolvers<void>();
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));
    let conversions = 0;

    const completion = superviseWorker(worker, {
      tools: {
        read: () => {
          started.resolve();

          return late.promise;
        },
      },
      control: { signal: controller.signal, interrupt: interruptFlag() },
    });

    await started.promise;
    controller.abort();
    await termination.terminating;
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

    expect((await completion).calls).toEqual([
      { callId: 1, name: "read", status: "interrupted", reason: "cancelled" },
    ]);
    expect(conversions).toBe(0);
    expect(termination.terminate).toHaveBeenCalledTimes(1);
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
  });

  test("preserves the output-limit snapshot when cleanup rejects", async () => {
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
          kind: "limit",
          resource: "output",
          maximum: 1,
          message: "Output exceeds the 1 byte limit.",
        },
      },
    });
    const error = await executionErrorOf(completion);

    expect(error.cause).toBe(cause);
    expect(error.calls).toEqual([
      { callId: 1, name: "read", status: "interrupted", reason: "output-limit" },
    ]);
    expect(terminate).toHaveBeenCalledTimes(1);
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
