import { describe, expect, spyOn, test } from "bun:test";
import { CodeExecutor, ToolResult } from "@cmg/codemode";

describe("CodeExecutor guest deadline", () => {
  test.each([
    ["message getter", "throw { get message() { while (true) {} } };"],
    ["toJSON", "throw { toJSON() { while (true) {} } };"],
  ])("reports timeout when error conversion loops in %s", async (_name, code) => {
    const sandbox = new CodeExecutor({ timeoutMs: 100 });

    const report = await sandbox.execute(code);

    expect(report.result).toEqual({
      ok: false,
      error: { kind: "timeout", message: "Execution exceeded the 100 ms limit." },
    });
  });

  test("applies a custom deadline to infinite computation and permits the next execution", async () => {
    const sandbox = new CodeExecutor({ timeoutMs: 100 });
    const started = performance.now();

    const { result } = await sandbox.execute("while (true) {} ");
    const elapsed = performance.now() - started;
    const recovered = await sandbox.execute("return 3;");

    expect(result).toEqual({
      ok: false,
      error: { kind: "timeout", message: "Execution exceeded the 100 ms limit." },
    });
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(recovered.result).toEqual({
      ok: true,
      value: 3,
    });
  });

  test("allows computation beyond one second when no guest deadline is configured", async () => {
    const report = await new CodeExecutor().execute(`
      const started = Date.now();
      while (Date.now() - started < 1100) {}
      return 42;
    `);

    expect(report).toEqual({ result: { ok: true, value: 42 }, calls: [] });
  });

  test("times out an infinite guest microtask chain and recovers", async () => {
    const sandbox = new CodeExecutor({
      timeoutMs: 100,
      tools: {
        answer: () => ToolResult.success(3),
      },
    });

    const timedOut = await sandbox.execute("while (true) await Promise.resolve();");
    const recovered = await sandbox.execute("return await tools.answer();");

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

    const report = await new CodeExecutor({
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

    const sandbox = new CodeExecutor({
      tools: { wait: () => late.promise, answer: () => ToolResult.success(3) },
      timeoutMs: 100,
    });

    const timedOut = await sandbox.execute("return await tools.wait();");

    settle(late);
    await Bun.sleep(0);

    const recovered = await sandbox.execute("return await tools.answer();");

    expect(timedOut.result).toEqual({
      ok: false,
      error: { kind: "timeout", message: "Execution exceeded the 100 ms limit." },
    });
    expect(recovered.result).toEqual({ ok: true, value: 3 });
  });
});

describe("total deadline", () => {
  test("expires during a host wait, aborts the tool, and discards its late response", async () => {
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));
    const signals: AbortSignal[] = [];
    let conversions = 0;

    const sandbox = new CodeExecutor({
      timeoutMs: 10000,
      totalTimeoutMs: 1000,
      tools: {
        read: (_args, { signal }) => {
          signals.push(signal);

          return late.promise;
        },
      },
    });

    const report = await sandbox.execute("return await tools.read();");
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
        error: { kind: "timeout", message: "Execution exceeded the 1000 ms total limit." },
      },
      calls: [{ callId: 1, name: "read", status: "interrupted", reason: "timeout" }],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(conversions).toBe(0);
  });

  test("does not convert a response after synchronous callback work exhausts the budget", async () => {
    let calls = 0;
    let conversions = 0;
    const now = performance.now();
    using clock = spyOn(performance, "now").mockReturnValue(now);

    const sandbox = new CodeExecutor({
      timeoutMs: 10000,
      totalTimeoutMs: 1000,
      tools: {
        read: () => {
          calls++;
          clock.mockReturnValue(now + 1001);

          return ToolResult.success({
            toJSON() {
              conversions++;

              return 42;
            },
          });
        },
      },
    });

    const report = await sandbox.execute("return await tools.read();");

    expect(report).toEqual({
      result: {
        ok: false,
        error: { kind: "timeout", message: "Execution exceeded the 1000 ms total limit." },
      },
      calls: [{ callId: 1, name: "read", status: "interrupted", reason: "timeout" }],
    });
    expect(calls).toBe(1);
    expect(conversions).toBe(0);
  });

  test("marks the call interrupted when JSON conversion exhausts the budget", async () => {
    let conversions = 0;
    const now = performance.now();
    using clock = spyOn(performance, "now").mockReturnValue(now);

    const sandbox = new CodeExecutor({
      timeoutMs: 10000,
      totalTimeoutMs: 1000,
      tools: {
        read: () =>
          ToolResult.success({
            toJSON() {
              conversions++;
              clock.mockReturnValue(now + 1001);

              return 42;
            },
          }),
      },
    });

    const report = await sandbox.execute("return await tools.read();");

    expect(report).toEqual({
      result: {
        ok: false,
        error: { kind: "timeout", message: "Execution exceeded the 1000 ms total limit." },
      },
      calls: [{ callId: 1, name: "read", status: "interrupted", reason: "timeout" }],
    });
    expect(conversions).toBe(1);
  });

  test("chooses an expired total deadline when cancellation arrives before the timer can run", async () => {
    const controller = new AbortController();
    const now = performance.now();
    using clock = spyOn(performance, "now").mockReturnValue(now);

    const sandbox = new CodeExecutor({
      timeoutMs: 10000,
      totalTimeoutMs: 1000,
      tools: {
        read: () => {
          clock.mockReturnValue(now + 1001);
          controller.abort();

          return ToolResult.success(42);
        },
      },
    });

    const report = await sandbox.execute("return await tools.read();", {
      signal: controller.signal,
    });

    expect(controller.signal.aborted).toBe(true);
    expect(report).toEqual({
      result: {
        ok: false,
        error: { kind: "timeout", message: "Execution exceeded the 1000 ms total limit." },
      },
      calls: [{ callId: 1, name: "read", status: "interrupted", reason: "timeout" }],
    });
  });

  test("accepts the minimum total budget", async () => {
    const { result } = await new CodeExecutor({ totalTimeoutMs: 1 }).execute("while (true) {}");

    expect(result).toEqual({
      ok: false,
      error: { kind: "timeout", message: "Execution exceeded the 1 ms total limit." },
    });
  });

  test("preserves a guest timeout that arrives before the parent deadline", async () => {
    const { result } = await new CodeExecutor({ timeoutMs: 50, totalTimeoutMs: 2000 }).execute(
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
        await new CodeExecutor().execute(`
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
