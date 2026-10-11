import { describe, expect, test } from "bun:test";
import { execute, ToolResult } from "../../src/sandbox";
import { rejectionOf } from "../support/rejection";

describe("guest deadline", () => {
  test("applies a custom deadline to infinite computation and permits the next execution", async () => {
    const started = performance.now();

    const { result } = await execute("while (true) {} ", {}, { timeoutMs: 100 });
    const elapsed = performance.now() - started;

    expect(result).toEqual({
      ok: false,
      error: { kind: "timeout", message: "Execution exceeded the 100 ms limit." },
    });
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(1000);
    expect((await execute("return 3;")).result).toEqual({ ok: true, value: 3 });
  });

  test("applies the default one-second deadline", async () => {
    const started = performance.now();

    const { result } = await execute("while (true) {} ");

    expect(result).toEqual({
      ok: false,
      error: { kind: "timeout", message: "Execution exceeded the 1000 ms limit." },
    });
    expect(performance.now() - started).toBeGreaterThanOrEqual(1000);
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", NaN],
    ["infinite", Infinity],
    ["overflowing", 2 ** 31],
  ] as const)("rejects a %s guest deadline", async (_name, timeoutMs) => {
    const failure = (await rejectionOf(execute("return 3;", {}, { timeoutMs }))).reason;

    expect(failure).toBeInstanceOf(RangeError);
    if (failure instanceof RangeError) {
      expect(failure.message).toBe("timeoutMs must be an integer from 1 to 2147483647.");
    }
  });
});

describe("total deadline", () => {
  for (const [name, totalTimeoutMs] of [
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", NaN],
    ["infinite", Infinity],
    ["overflowing", 2 ** 31],
  ] as const) {
    test(`rejects a ${name} total budget before reading tools`, async () => {
      let reads = 0;

      const failure = (
        await rejectionOf(
          execute(
            "return 42;",
            {
              get read() {
                reads++;

                return () => ToolResult.success();
              },
            },
            { totalTimeoutMs },
          ),
        )
      ).reason;

      expect(failure).toBeInstanceOf(RangeError);
      if (failure instanceof RangeError) {
        expect(failure.message).toBe("totalTimeoutMs must be an integer from 1 to 2147483647.");
      }

      expect(reads).toBe(0);
    });
  }

  test("accepts the minimum total budget", async () => {
    const { result } = await execute("while (true) {}", {}, { totalTimeoutMs: 1 });

    expect(result).toEqual({
      ok: false,
      error: { kind: "timeout", message: "Execution exceeded the 1 ms total limit." },
    });
  });

  test("preserves a guest timeout that arrives before the parent deadline", async () => {
    const { result } = await execute(
      "while (true) {}",
      {},
      { timeoutMs: 50, totalTimeoutMs: 2000 },
    );

    expect(result).toEqual({
      ok: false,
      error: { kind: "timeout", message: "Execution exceeded the 50 ms limit." },
    });
  });
});
