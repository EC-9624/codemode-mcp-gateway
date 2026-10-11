import { describe, expect, test } from "bun:test";
import { execute } from "../../src/sandbox";

describe("worker-backed execution", () => {
  test("retains the private prelude boundary", async () => {
    expect(
      (await execute("return [typeof hostTools, typeof run, tools === globalThis.tools];")).result,
    ).toEqual({ ok: true, value: ["undefined", "undefined", true] });
    const escaped = (await execute("}); globalThis.escaped = true; (async () => {")).result;
    expect(escaped.ok).toBe(false);
    if (!escaped.ok) expect(escaped.error.kind).toBe("script");
  });

  test("creates fresh guest state for each execution", async () => {
    expect(
      (await execute("globalThis.marker = 3; Array.prototype.marker = 3; return marker;")).result,
    ).toEqual({ ok: true, value: 3 });
    expect(
      (await execute("return [typeof marker, typeof Array.prototype.marker];")).result,
    ).toEqual({
      ok: true,
      value: ["undefined", "undefined"],
    });
  });

  test("routes results to the correct concurrent execution", async () => {
    const results = await Promise.all([1, 2, 3, 4].map((value) => execute(`return ${value};`)));

    expect(results.map((report) => report.result)).toEqual([
      { ok: true, value: 1 },
      { ok: true, value: 2 },
      { ok: true, value: 3 },
      { ok: true, value: 4 },
    ]);
  });

  test("keeps main-thread timers running during guest computation, not just worker startup", async () => {
    const ticks: number[] = [];
    const timer = setInterval(() => ticks.push(Date.now()), 10);
    try {
      const result = (
        await execute(`
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

  test("interrupts infinite guest computation and recovers", async () => {
    const result = (await execute("while (true) {} ", {}, { timeoutMs: 100 })).result;

    expect(result).toEqual({
      ok: false,
      error: { kind: "timeout", message: "Execution exceeded the 100 ms limit." },
    });
    expect((await execute("return 42;")).result).toEqual({ ok: true, value: 42 });
  });
});
