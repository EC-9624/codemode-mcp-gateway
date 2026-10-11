import { describe, expect, spyOn, test } from "bun:test";
import { ToolResult } from "../../src/sandbox";
import { superviseWorker } from "../../src/worker-execution";
import { executionErrorOf } from "../support/execution-error";
import { faultWorker, toolWorker } from "../support/workers";

describe("parent-owned call outcomes", () => {
  test("records dispatch before a callback synchronously cancels execution", async () => {
    const controller = new AbortController();
    const worker = toolWorker("return await tools.read();");

    const report = await superviseWorker(
      worker,
      new Map([
        [
          "read",
          () => {
            controller.abort();

            return ToolResult.success(42);
          },
        ],
      ]),
      { signal: controller.signal, interrupt: new Int32Array(new SharedArrayBuffer(4)) },
    );

    expect(report).toEqual({
      result: { ok: false, error: { kind: "cancelled", message: "Execution cancelled." } },
      calls: [{ callId: 1, name: "read", status: "interrupted", reason: "cancelled" }],
    });
  });

  test("closes the snapshot before abort listeners settle tools or emit new calls", async () => {
    const controller = new AbortController();
    const worker = faultWorker("idle");
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));
    let invocations = 0;
    let conversions = 0;
    using post = spyOn(worker, "postMessage");

    const completion = superviseWorker(
      worker,
      new Map([
        [
          "read",
          (_args, { signal }) => {
            invocations++;
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
                worker.emit("message", {
                  type: "tool-call",
                  callId: 2,
                  name: "read",
                  argsJson: undefined,
                });
              },
              { once: true },
            );

            return late.promise;
          },
        ],
      ]),
      { signal: controller.signal, interrupt: new Int32Array(new SharedArrayBuffer(4)) },
    );

    worker.emit("message", { type: "tool-call", callId: 1, name: "read", argsJson: undefined });
    controller.abort();
    const report = await completion;

    expect(report.calls).toEqual([
      { callId: 1, name: "read", status: "interrupted", reason: "cancelled" },
    ]);
    expect(invocations).toBe(1);
    expect(conversions).toBe(0);
    expect(post).not.toHaveBeenCalled();
  });

  test("retains completed and pending calls when the worker fails", async () => {
    const worker = toolWorker("await tools.read(1); return await tools.read(2);");
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));

    const error = await executionErrorOf(
      superviseWorker(
        worker,
        new Map([
          [
            "read",
            (args) => {
              if (args === 1) return ToolResult.success(42);

              worker.emit("error", new Error("Private worker details"));

              return late.promise;
            },
          ],
        ]),
      ),
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

  test("keeps the timeout interruption reason when cancellation arrives after deadline selection", async () => {
    const controller = new AbortController();

    const control = {
      deadline: { timeoutMs: 10000, expiresAt: performance.now() + 10000 },
      interrupt: new Int32Array(new SharedArrayBuffer(4)),
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

    const completion = superviseWorker(
      worker,
      new Map([
        [
          "read",
          (args) => {
            if (args === 1) return ToolResult.success(42);

            started.resolve();

            return late.promise;
          },
        ],
      ]),
      control,
    );

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
    const terminateWorker = worker.terminate.bind(worker);
    const terminating = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => release.resolve());
    cleanup.defer(() => late.resolve(ToolResult.success()));
    let conversions = 0;

    using terminate = spyOn(worker, "terminate").mockImplementation(async () => {
      const code = await terminateWorker();
      terminating.resolve();
      await release.promise;

      return code;
    });

    const completion = superviseWorker(
      worker,
      new Map([
        [
          "read",
          () => {
            started.resolve();

            return late.promise;
          },
        ],
      ]),
      { signal: controller.signal, interrupt: new Int32Array(new SharedArrayBuffer(4)) },
    );

    await started.promise;
    controller.abort();
    await terminating.promise;
    late.resolve(
      ToolResult.success({
        toJSON() {
          conversions++;

          return 42;
        },
      }),
    );
    await Bun.sleep(0);
    release.resolve();

    expect((await completion).calls).toEqual([
      { callId: 1, name: "read", status: "interrupted", reason: "cancelled" },
    ]);
    expect(conversions).toBe(0);
    expect(terminate).toHaveBeenCalledTimes(1);
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

    const completion = superviseWorker(
      worker,
      new Map([
        [
          "read",
          (args) => {
            if (args === 1) return ToolResult.success(42);

            started.resolve();

            return late.promise;
          },
        ],
      ]),
      { signal: controller.signal, interrupt: new Int32Array(new SharedArrayBuffer(4)) },
    );

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

    const completion = superviseWorker(worker, new Map([["read", () => late.promise]]));

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

    const completion = superviseWorker(worker, new Map([["read", () => late.promise]]));

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
