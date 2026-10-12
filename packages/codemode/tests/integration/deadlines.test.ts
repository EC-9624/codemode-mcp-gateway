import { describe, expect, test } from "bun:test";
import { CodemodeSandbox, ToolResult } from "@cmg/codemode";

describe("guest deadline", () => {
  test("applies a custom deadline to infinite computation and permits the next execution", async () => {
    const started = performance.now();

    const { result } = await new CodemodeSandbox({ timeoutMs: 100 }).execute("while (true) {} ");
    const elapsed = performance.now() - started;

    expect(result).toEqual({
      ok: false,
      error: { kind: "timeout", message: "Execution exceeded the 100 ms limit." },
    });
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(1000);
    expect((await new CodemodeSandbox().execute("return 3;")).result).toEqual({
      ok: true,
      value: 3,
    });
  });

  test("applies the default one-second deadline", async () => {
    const started = performance.now();

    const { result } = await new CodemodeSandbox().execute("while (true) {} ");

    expect(result).toEqual({
      ok: false,
      error: { kind: "timeout", message: "Execution exceeded the 1000 ms limit." },
    });
    expect(performance.now() - started).toBeGreaterThanOrEqual(1000);
  });

  test("times out an infinite guest microtask chain and recovers", async () => {
    const timedOut = await new CodemodeSandbox({ timeoutMs: 100 }).execute(
      "while (true) await Promise.resolve();",
    );

    const recovered = await new CodemodeSandbox({
      tools: {
        answer: () => ToolResult.success(3),
      },
    }).execute("return await tools.answer();");

    expect(timedOut.result).toEqual({
      ok: false,
      error: { kind: "timeout", message: "Execution exceeded the 100 ms limit." },
    });
    expect(recovered.result).toEqual({ ok: true, value: 3 });
  });

  test("includes unawaited host calls in the deadline", async () => {
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));

    const report = await new CodemodeSandbox({
      tools: { wait: () => late.promise },
      timeoutMs: 100,
    }).execute("tools.wait(); return 3;");

    expect(report).toEqual({
      result: {
        ok: false,
        error: { kind: "timeout", message: "Execution exceeded the 100 ms limit." },
      },
      calls: [{ callId: 1, name: "wait", status: "interrupted", reason: "timeout" }],
    });
  });

  test.each([
    ["fulfills", (late: PromiseWithResolvers<ToolResult>) => late.resolve(ToolResult.success(3))],
    [
      "rejects",
      (late: PromiseWithResolvers<ToolResult>) => late.reject(new Error("Late private failure")),
    ],
  ] as const)("allows new executions after a timed-out callback %s late", async (_name, settle) => {
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));

    const timedOut = await new CodemodeSandbox({
      tools: { wait: () => late.promise },
      timeoutMs: 100,
    }).execute("return await tools.wait();");

    settle(late);
    await Bun.sleep(0);

    const recovered = await new CodemodeSandbox({
      tools: {
        answer: () => ToolResult.success(3),
      },
    }).execute("return await tools.answer();");

    expect(timedOut.result).toEqual({
      ok: false,
      error: { kind: "timeout", message: "Execution exceeded the 100 ms limit." },
    });
    expect(recovered.result).toEqual({ ok: true, value: 3 });
  });
});

describe("total deadline", () => {
  test("accepts the minimum total budget", async () => {
    const { result } = await new CodemodeSandbox({ totalTimeoutMs: 1 }).execute("while (true) {}");

    expect(result).toEqual({
      ok: false,
      error: { kind: "timeout", message: "Execution exceeded the 1 ms total limit." },
    });
  });

  test("preserves a guest timeout that arrives before the parent deadline", async () => {
    const { result } = await new CodemodeSandbox({ timeoutMs: 50, totalTimeoutMs: 2000 }).execute(
      "while (true) {}",
    );

    expect(result).toEqual({
      ok: false,
      error: { kind: "timeout", message: "Execution exceeded the 50 ms limit." },
    });
  });
});

describe("host responsiveness", () => {
  test("keeps main-thread timers running during guest computation, not just worker startup", async () => {
    const ticks: number[] = [];
    const timer = setInterval(() => ticks.push(Date.now()), 10);
    try {
      const result = (
        await new CodemodeSandbox().execute(`
        const started = Date.now();
        while (Date.now() - started < 400) {}
        return { started, ended: Date.now() };
      `)
      ).result;

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const value = result.value;
      if (
        typeof value !== "object" ||
        value === null ||
        !("started" in value) ||
        typeof value.started !== "number" ||
        !("ended" in value) ||
        typeof value.ended !== "number"
      )
        throw new Error("Expected numeric guest computation timestamps.");

      const started = value.started;
      const ended = value.ended;
      expect(ticks.some((tick) => tick > started + 50 && tick < ended - 50)).toBe(true);
    } finally {
      clearInterval(timer);
    }
  });
});
