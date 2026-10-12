import { describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { CodemodeSandbox, ToolResult, type SandboxResult, type ToolContext } from "@cmg/codemode";

const cancelled = {
  ok: false,
  error: { kind: "cancelled", message: "Execution cancelled." },
} satisfies SandboxResult;

describe("caller cancellation", () => {
  test("pre-aborted execution skips tool dispatch and keeps the reason private", async () => {
    const controller = new AbortController();
    controller.abort(() => "Private cancellation reason");
    let reads = 0;

    const report = await new CodemodeSandbox({
      tools: {
        read: () => {
          reads++;

          return ToolResult.success();
        },
      },
    }).execute("return await tools.read();", { signal: controller.signal });

    expect(report).toEqual({ result: cancelled, calls: [] });
    expect(reads).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  test("observes cancellation requested during sandbox construction", async () => {
    const controller = new AbortController();
    let calls = 0;

    const { result } = await new CodemodeSandbox({
      tools: {
        get read() {
          controller.abort();

          return () => ToolResult.success(++calls);
        },
      },
    }).execute("return await tools.read();", { signal: controller.signal });

    expect(result).toEqual(cancelled);
    expect(calls).toBe(0);
  });
});

describe("host tool cancellation", () => {
  test("shares the signal across concurrent calls and lets cooperative tools settle", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const signals: AbortSignal[] = [];
    let stopped = 0;

    const completion = new CodemodeSandbox({
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
    controller.abort();

    expect((await completion).result).toEqual(cancelled);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
    expect(stopped).toBe(2);
    for (const signal of signals) {
      expect(signal.aborted).toBe(true);
      expect(getEventListeners(signal, "abort")).toHaveLength(0);
    }
  });

  for (const [name, code, options, kind] of [
    ["guest timeout", "return await tools.read();", { timeoutMs: 100 }, "timeout"],
    [
      "total timeout",
      "return await tools.read();",
      { timeoutMs: 10000, totalTimeoutMs: 500 },
      "timeout",
    ],
    ["script failure", "tools.read(); throw new Error('failed');", {}, "script"],
  ] as const) {
    test(`requests tool cancellation on ${name}`, async () => {
      const contexts: ToolContext[] = [];
      const late = Promise.withResolvers<ToolResult>();
      using cleanup = new DisposableStack();
      cleanup.defer(() => late.resolve(ToolResult.success()));

      const { result } = await new CodemodeSandbox({
        tools: {
          read: (_args, context) => {
            contexts.push(context);

            return late.promise;
          },
        },
        ...options,
      }).execute(code);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe(kind);

      expect(contexts).toHaveLength(1);
      expect(contexts[0]?.signal.aborted).toBe(true);
    });
  }

  test("isolates concurrent executions and leaves successful tool signals un-aborted", async () => {
    const controller = new AbortController();
    const survivor = new AbortController();
    const started = Promise.withResolvers<void>();
    const contexts: ToolContext[] = [];
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));

    const first = new CodemodeSandbox({
      tools: {
        read: (_args, context) => {
          contexts.push(context);
          started.resolve();

          return late.promise;
        },
      },
    }).execute("return await tools.read();", { signal: controller.signal });

    await started.promise;

    const second = await new CodemodeSandbox({
      tools: {
        read: (_args, context) => {
          contexts.push(context);
          controller.abort();

          return ToolResult.success(42);
        },
      },
    }).execute("return await tools.read();", { signal: survivor.signal });

    survivor.abort();

    expect((await first).result).toEqual(cancelled);
    expect(second.result).toEqual({ ok: true, value: 42 });
    expect(contexts).toHaveLength(2);
    expect(contexts[0]?.signal.aborted).toBe(true);
    expect(contexts[1]?.signal.aborted).toBe(false);
    expect(contexts[0]?.signal).not.toBe(contexts[1]?.signal);
    expect(getEventListeners(survivor.signal, "abort")).toHaveLength(0);
  });

  test("reports script failure without waiting for unrelated callbacks and recovers", async () => {
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));

    const failed = await new CodemodeSandbox({
      tools: {
        wait: () => late.promise,
      },
    }).execute('tools.wait(); throw new Error("Script failed");');

    late.resolve(ToolResult.success(3));
    await Bun.sleep(0);
    const recovered = await new CodemodeSandbox().execute("return 3;");

    expect(failed.result).toEqual({
      ok: false,
      error: { kind: "script", message: "Script failed" },
    });
    expect(recovered.result).toEqual({ ok: true, value: 3 });
  });
});
