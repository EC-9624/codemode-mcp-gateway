import { describe, expect, spyOn, test } from "bun:test";
import { getEventListeners } from "node:events";
import { CodeExecutor, ToolResult, type ToolContext } from "@cmg/codemode";
import { executionErrorOf } from "./support/execution-error.ts";

describe("CodeExecutor cancellation", () => {
  test("pre-aborted execution skips tool dispatch and keeps the reason private", async () => {
    const controller = new AbortController();
    controller.abort(() => "Private cancellation reason");
    let reads = 0;

    const report = await new CodeExecutor({
      tools: {
        read: () => {
          reads++;

          return ToolResult.success();
        },
      },
    }).execute("return await tools.read();", { signal: controller.signal });

    expect(report).toEqual({
      result: { ok: false, error: { kind: "cancelled", message: "Execution cancelled." } },
      calls: [],
    });
    expect(reads).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  test("observes cancellation between worker creation and abort-listener registration", async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    const addListener = signal.addEventListener.bind(signal);

    // This registration race cannot be scheduled deterministically from guest code.
    using add = spyOn(signal, "addEventListener").mockImplementation(
      (...args: Parameters<AbortSignal["addEventListener"]>) => {
        controller.abort();
        addListener(...args);
      },
    );

    const report = await new CodeExecutor().execute("return 42;", { signal });

    expect(report).toEqual({
      result: { ok: false, error: { kind: "cancelled", message: "Execution cancelled." } },
      calls: [],
    });
    expect(add).toHaveBeenCalledTimes(1);
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
  });

  test("unwinds partial abort-listener registration and preserves its host-only cause", async () => {
    const signal = new AbortController().signal;
    const addListener = signal.addEventListener.bind(signal);
    const failure = new Error("Abort listener setup failed");

    using add = spyOn(signal, "addEventListener").mockImplementation(
      (...args: Parameters<AbortSignal["addEventListener"]>) => {
        addListener(...args);
        throw failure;
      },
    );

    const error = await executionErrorOf(new CodeExecutor().execute("return 42;", { signal }));

    expect(error.cause).toBe(failure);
    expect(error.calls).toEqual([]);
    expect(add).toHaveBeenCalledTimes(1);
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
  });
});

describe("host tool cancellation", () => {
  test("shares the signal across concurrent calls and lets cooperative tools settle", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const signals: AbortSignal[] = [];
    let stopped = 0;

    const completion = new CodeExecutor({
      tools: {
        read: async (_args, { signal }) => {
          signals.push(signal);
          const aborted = Promise.withResolvers<void>();
          const onAbort = () => aborted.resolve();
          using cleanup = new DisposableStack();
          cleanup.defer(() => signal.removeEventListener("abort", onAbort));
          signal.addEventListener("abort", onAbort, { once: true });
          if (signals.length === 2) started.resolve();

          await aborted.promise;
          stopped++;

          return ToolResult.failure("Stopped");
        },
      },
    }).execute("return await Promise.all([tools.read(), tools.read()]);", {
      signal: controller.signal,
    });

    await started.promise;
    const privateReason = new Error("Private caller reason");
    controller.abort(privateReason);

    expect((await completion).result).toEqual({
      ok: false,
      error: { kind: "cancelled", message: "Execution cancelled." },
    });
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
    expect(stopped).toBe(2);
    for (const signal of signals) {
      expect(signal.aborted).toBe(true);
      expect(signal).not.toBe(controller.signal);
      expect(signal.reason).toBeInstanceOf(DOMException);
      expect(signal.reason).toMatchObject({
        name: "AbortError",
        message: "Sandbox execution ended.",
      });
      expect(signal.reason).not.toBe(privateReason);
      expect(getEventListeners(signal, "abort")).toHaveLength(0);
    }
  });

  test("records dispatch before a callback synchronously cancels execution", async () => {
    const controller = new AbortController();

    const sandbox = new CodeExecutor({
      tools: {
        read: () => {
          controller.abort();

          return ToolResult.success(42);
        },
      },
    });

    const report = await sandbox.execute(
      'try { return await tools.read(); } catch { return "caught"; }',
      { signal: controller.signal },
    );

    expect(report).toEqual({
      result: { ok: false, error: { kind: "cancelled", message: "Execution cancelled." } },
      calls: [{ callId: 1, name: "read", status: "interrupted", reason: "cancelled" }],
    });
  });

  test("drops a response that cancels execution during its JSON conversion", async () => {
    const controller = new AbortController();

    const sandbox = new CodeExecutor({
      tools: {
        read: () =>
          ToolResult.success({
            toJSON() {
              controller.abort();

              return 42;
            },
          }),
      },
    });

    const report = await sandbox.execute(
      'try { return await tools.read(); } catch { return "caught"; }',
      { signal: controller.signal },
    );

    expect(report).toEqual({
      result: { ok: false, error: { kind: "cancelled", message: "Execution cancelled." } },
      calls: [{ callId: 1, name: "read", status: "interrupted", reason: "cancelled" }],
    });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  test("isolates concurrent executions and leaves successful tool signals un-aborted", async () => {
    const controller = new AbortController();
    const survivor = new AbortController();
    const started = Promise.withResolvers<void>();
    const contexts: ToolContext[] = [];
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));

    const first = new CodeExecutor({
      tools: {
        read: (_args, context) => {
          contexts.push(context);
          started.resolve();

          return late.promise;
        },
      },
    }).execute("return await tools.read();", { signal: controller.signal });

    await started.promise;

    const second = await new CodeExecutor({
      tools: {
        read: (_args, context) => {
          contexts.push(context);
          controller.abort();

          return ToolResult.success(42);
        },
      },
    }).execute("return await tools.read();", { signal: survivor.signal });

    survivor.abort();

    expect((await first).result).toEqual({
      ok: false,
      error: { kind: "cancelled", message: "Execution cancelled." },
    });
    expect(second.result).toEqual({ ok: true, value: 42 });
    expect(contexts).toHaveLength(2);
    expect(contexts[0]?.signal.aborted).toBe(true);
    expect(contexts[1]?.signal.aborted).toBe(false);
    expect(contexts[0]?.signal).not.toBe(contexts[1]?.signal);
    expect(getEventListeners(survivor.signal, "abort")).toHaveLength(0);
  });

  test("observes a late callback rejection after cancellation and permits recovery", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));

    const sandbox = new CodeExecutor({
      tools: {
        wait: () => {
          started.resolve();

          return late.promise;
        },
      },
    });

    const completion = sandbox.execute("return await tools.wait();", { signal: controller.signal });

    await started.promise;
    controller.abort();
    const report = await completion;
    late.reject(new Error("Private late failure"));
    await Bun.sleep(0);
    const recovered = await sandbox.execute("return 3;");

    expect(report).toEqual({
      result: { ok: false, error: { kind: "cancelled", message: "Execution cancelled." } },
      calls: [{ callId: 1, name: "wait", status: "interrupted", reason: "cancelled" }],
    });
    expect(recovered.result).toEqual({ ok: true, value: 3 });
  });
});
