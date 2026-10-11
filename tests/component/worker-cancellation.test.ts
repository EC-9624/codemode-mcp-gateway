import { describe, expect, spyOn, test } from "bun:test";
import { getEventListeners } from "node:events";
import { execute, ToolResult, type SandboxResult, type ToolContext } from "../../src/sandbox";
import { superviseWorker, type WorkerControl } from "../../src/worker-execution";
import { executionErrorOf } from "../support/execution-error";
import { faultWorker, toolWorker } from "../support/workers";

const cancelled = {
  ok: false,
  error: { kind: "cancelled", message: "Execution cancelled." },
} satisfies SandboxResult;

describe("worker cancellation", () => {
  test("cancels stalled startup, sets the interrupt flag, and recovers", async () => {
    const controller = new AbortController();
    const control = cancellationControl(controller.signal);
    const worker = faultWorker("startup-stall");
    using terminate = spyOn(worker, "terminate");
    const completion = superviseWorker(worker, new Map(), control);

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    controller.abort();
    expect(Atomics.load(control.interrupt, 0)).toBe(1);
    expect((await completion).result).toEqual(cancelled);
    expect(terminate).toHaveBeenCalledTimes(1);
    expectCleanedUp(worker, controller.signal);
    expect((await execute("return 42;")).result).toEqual({ ok: true, value: 42 });
  });

  test("observes an already-aborted signal when taking worker ownership", async () => {
    const signal = AbortSignal.abort();
    const control = cancellationControl(signal);
    const worker = faultWorker("idle");

    expect((await superviseWorker(worker, new Map(), control)).result).toEqual(cancelled);
    expect(Atomics.load(control.interrupt, 0)).toBe(1);
    expectCleanedUp(worker, signal);
  });

  for (const outcome of ["success", "failure"] as const) {
    test(`discards late tool ${outcome} after cancellation without conversion or transport`, async () => {
      const controller = new AbortController();
      const control = cancellationControl(controller.signal);

      const worker = toolWorker(
        "try { return await tools.read(); } catch { return 'caught'; }",
        10000,
        control.interrupt.buffer,
      );

      const started = Promise.withResolvers<ToolContext>();
      const late = Promise.withResolvers<ToolResult>();
      using cleanup = new DisposableStack();
      cleanup.defer(() => late.resolve(ToolResult.success()));
      let conversions = 0;
      using post = spyOn(worker, "postMessage");

      const completion = superviseWorker(
        worker,
        new Map([
          [
            "read",
            (_args, context) => {
              started.resolve(context);

              return late.promise;
            },
          ],
        ]),
        control,
      );

      const context = await started.promise;
      const privateReason = new Error("Private caller details");
      expect(context.signal).not.toBe(controller.signal);
      expect(context.signal.aborted).toBe(false);

      controller.abort(privateReason);
      expect(context.signal.aborted).toBe(true);
      const reason: unknown = context.signal.reason;
      expect(reason).toBeInstanceOf(DOMException);
      if (reason instanceof DOMException) {
        expect(reason.name).toBe("AbortError");
        expect(reason.message).toBe("Sandbox execution ended.");
      }

      expect(reason).not.toBe(privateReason);
      const report = await completion;
      expect(report).toEqual({
        result: cancelled,
        calls: [{ callId: 1, name: "read", status: "interrupted", reason: "cancelled" }],
      });

      if (outcome === "failure") late.reject(new Error("Private late tool failure"));
      else
        late.resolve(
          ToolResult.success({
            toJSON() {
              conversions++;

              return 42;
            },
          }),
        );

      await Bun.sleep(0);

      expect(conversions).toBe(0);
      expect(report.calls).toEqual([
        { callId: 1, name: "read", status: "interrupted", reason: "cancelled" },
      ]);
      expect(post).not.toHaveBeenCalled();
      expectCleanedUp(worker, controller.signal);
    });
  }

  test("closes dispatch before notifying reentrant tool abort listeners", async () => {
    const controller = new AbortController();
    const worker = faultWorker("idle");
    let calls = 0;
    const call = { type: "tool-call", callId: 1, name: "read", argsJson: undefined };

    const completion = superviseWorker(
      worker,
      new Map([
        [
          "read",
          (_args, context) => {
            calls++;
            context.signal.addEventListener(
              "abort",
              () => {
                worker.emit("message", { ...call, callId: 2 });
                worker.emit("message", { type: "completed", result: { ok: true, value: 42 } });
              },
              { once: true },
            );

            return ToolResult.success();
          },
        ],
      ]),
      cancellationControl(controller.signal),
    );

    worker.emit("message", call);
    controller.abort();

    expect((await completion).result).toEqual(cancelled);
    expect(calls).toBe(1);
    expectCleanedUp(worker, controller.signal);
  });

  test("drops a result that cancels execution from toJSON", async () => {
    const controller = new AbortController();
    const worker = toolWorker("return await tools.read();");
    using post = spyOn(worker, "postMessage");

    const report = await superviseWorker(
      worker,
      new Map([
        [
          "read",
          () =>
            ToolResult.success({
              toJSON() {
                controller.abort();

                return 42;
              },
            }),
        ],
      ]),
      cancellationControl(controller.signal),
    );

    expect(report).toEqual({
      result: cancelled,
      calls: [{ callId: 1, name: "read", status: "interrupted", reason: "cancelled" }],
    });
    expect(post).not.toHaveBeenCalled();
    expectCleanedUp(worker, controller.signal);
  });

  test("keeps cancellation accepted before the total deadline expires", async () => {
    const controller = new AbortController();

    const control = {
      ...cancellationControl(controller.signal),
      deadline: { timeoutMs: 10000, expiresAt: performance.now() + 10000 },
    };

    const worker = faultWorker("idle");
    const completion = superviseWorker(worker, new Map(), control);

    controller.abort();
    control.deadline.expiresAt = performance.now() - 1;

    expect((await completion).result).toEqual(cancelled);
    expectCleanedUp(worker, controller.signal);
  });

  test("chooses timeout when cancellation observes an expired total deadline", async () => {
    const controller = new AbortController();

    const control = {
      ...cancellationControl(controller.signal),
      deadline: { timeoutMs: 10000, expiresAt: performance.now() + 10000 },
    };

    const worker = faultWorker("idle");
    const completion = superviseWorker(worker, new Map(), control);

    control.deadline.expiresAt = performance.now() - 1;
    controller.abort();

    expect((await completion).result).toEqual({
      ok: false,
      error: { kind: "timeout", message: "Execution exceeded the 10000 ms total limit." },
    });
    expectCleanedUp(worker, controller.signal);
  });

  test("preserves completion when the caller aborts during termination", async () => {
    const controller = new AbortController();
    const worker = faultWorker("idle");
    const terminateWorker = worker.terminate.bind(worker);
    const terminating = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => release.resolve());

    using terminate = spyOn(worker, "terminate").mockImplementation(async () => {
      const code = await terminateWorker();
      terminating.resolve();
      await release.promise;

      return code;
    });

    let settled = false;

    const completion = superviseWorker(
      worker,
      new Map(),
      cancellationControl(controller.signal),
    ).then((result) => {
      settled = true;

      return result;
    });

    const message = { type: "completed", result: { ok: true, value: 42 } };

    worker.emit("message", message);
    await terminating.promise;

    expect(settled).toBe(false);

    controller.abort();
    worker.emit("message", message);
    worker.emit("error", new Error("Private late worker error"));
    release.resolve();

    expect((await completion).result).toEqual({ ok: true, value: 42 });
    expect(terminate).toHaveBeenCalledTimes(1);
    expectCleanedUp(worker, controller.signal);
  });

  test("preserves cancellation when completion arrives during termination", async () => {
    const controller = new AbortController();
    const worker = faultWorker("idle");
    const terminateWorker = worker.terminate.bind(worker);
    const terminating = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => release.resolve());

    using terminate = spyOn(worker, "terminate").mockImplementation(async () => {
      const code = await terminateWorker();
      terminating.resolve();
      await release.promise;

      return code;
    });

    let settled = false;

    const completion = superviseWorker(
      worker,
      new Map(),
      cancellationControl(controller.signal),
    ).then((result) => {
      settled = true;

      return result;
    });

    controller.abort();
    await terminating.promise;

    expect(settled).toBe(false);

    controller.abort();
    worker.emit("message", { type: "completed", result: { ok: true, value: 42 } });
    worker.emit("error", new Error("Private late worker error"));
    release.resolve();

    expect((await completion).result).toEqual(cancelled);
    expect(terminate).toHaveBeenCalledTimes(1);
    expectCleanedUp(worker, controller.signal);
  });

  test("termination failure still rejects after caller cancellation", async () => {
    const controller = new AbortController();
    const worker = faultWorker("idle");
    const terminateWorker = worker.terminate.bind(worker);
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      await terminateWorker();
    });
    const failure = new Error("Termination failed");
    using terminate = spyOn(worker, "terminate").mockRejectedValue(failure);
    const completion = superviseWorker(worker, new Map(), cancellationControl(controller.signal));

    controller.abort();

    expect((await executionErrorOf(completion)).cause).toBe(failure);
    expect(terminate).toHaveBeenCalledTimes(1);
    expectCleanedUp(worker, controller.signal);
  });

  test("unwinds partial abort-listener registration", async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    const worker = faultWorker("idle");
    const addListener = signal.addEventListener.bind(signal);
    const failure = new Error("Abort listener setup failed");

    using add = spyOn(signal, "addEventListener").mockImplementation(
      (...args: Parameters<AbortSignal["addEventListener"]>) => {
        addListener(...args);
        throw failure;
      },
    );

    using terminate = spyOn(worker, "terminate");

    expect(
      (await executionErrorOf(superviseWorker(worker, new Map(), cancellationControl(signal))))
        .cause,
    ).toBe(failure);
    expect(add).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledTimes(1);
    expectCleanedUp(worker, signal);
  });

  test("observes cancellation just before abort-listener registration", async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    const worker = faultWorker("idle");
    const addListener = signal.addEventListener.bind(signal);

    using add = spyOn(signal, "addEventListener").mockImplementation(
      (...args: Parameters<AbortSignal["addEventListener"]>) => {
        controller.abort();
        addListener(...args);
      },
    );

    expect((await superviseWorker(worker, new Map(), cancellationControl(signal))).result).toEqual(
      cancelled,
    );
    expect(add).toHaveBeenCalledTimes(1);
    expectCleanedUp(worker, signal);
  });

  test("preserves an infrastructure failure accepted before cancellation", async () => {
    const controller = new AbortController();
    const worker = faultWorker("idle");
    const completion = superviseWorker(worker, new Map(), cancellationControl(controller.signal));

    worker.emit("error", new Error("Private worker error"));
    controller.abort();

    const failure = (await executionErrorOf(completion)).cause;
    expect(failure).toBeInstanceOf(Error);
    if (failure instanceof Error) {
      expect(failure.message).toBe(
        "Sandbox worker failed. Internal error details are not transferred.",
      );
    }

    expectCleanedUp(worker, controller.signal);
  });

  test("requests tool cancellation on worker infrastructure failure", async () => {
    const worker = faultWorker("idle");
    const contexts: ToolContext[] = [];
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));

    const completion = superviseWorker(
      worker,
      new Map([
        [
          "read",
          (_args, context) => {
            contexts.push(context);

            return late.promise;
          },
        ],
      ]),
    );

    worker.emit("message", { type: "tool-call", callId: 1, name: "read", argsJson: undefined });
    worker.emit("error", new Error("Private worker error"));

    expect((await executionErrorOf(completion)).cause).toBeInstanceOf(Error);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.signal.aborted).toBe(true);
  });
});

function cancellationControl(signal: AbortSignal): WorkerControl {
  return { signal, interrupt: new Int32Array(new SharedArrayBuffer(4)) };
}

function expectCleanedUp(worker: ReturnType<typeof faultWorker>, signal: AbortSignal) {
  for (const event of ["message", "messageerror", "exit", "error"]) {
    expect(worker.listenerCount(event)).toBe(0);
  }

  expect(getEventListeners(signal, "abort")).toHaveLength(0);
}
