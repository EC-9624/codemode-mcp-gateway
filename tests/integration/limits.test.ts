import { describe, expect, test } from "bun:test";
import { execute, ToolResult } from "../../src/sandbox";
import { executionErrorOf } from "../support/execution-error";
import { rejectionOf } from "../support/rejection";

describe("execution limit options", () => {
  for (const [name, maximum] of [
    ["memoryLimitBytes", 2147483647],
    ["maxStackSizeBytes", 4194304],
    ["maxSourceBytes", 2147483647],
    ["maxOutputBytes", 2147483647],
  ] as const) {
    test.each([
      ["zero", 0],
      ["negative", -1],
      ["fractional", 1.5],
      ["NaN", NaN],
      ["infinite", Infinity],
      ["overflowing", 2 ** 31],
    ] as const)(
      `rejects %s ${name} before registry access even when cancelled`,
      async (_label, value) => {
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
              { [name]: value, signal: AbortSignal.abort() },
            ),
          )
        ).reason;

        expect(failure).toBeInstanceOf(RangeError);
        if (failure instanceof RangeError) {
          expect(failure.message).toBe(`${name} must be an integer from 1 to ${maximum}.`);
        }

        expect(reads).toBe(0);
      },
    );
  }

  test.each([4194305, 8 * 1024 * 1024, 2147483647])(
    "rejects a %i byte stack limit before registry access even when cancelled",
    async (maxStackSizeBytes) => {
      let reads = 0;

      const failure = await rejectionOf(
        execute(
          "return 42;",
          {
            get read() {
              reads++;

              return () => ToolResult.success();
            },
          },
          { maxStackSizeBytes, signal: AbortSignal.abort() },
        ),
      );

      expect(failure.reason).toBeInstanceOf(RangeError);
      if (failure.reason instanceof RangeError) {
        expect(failure.reason.message).toBe(
          "maxStackSizeBytes must be an integer from 1 to 4194304.",
        );
      }

      expect(reads).toBe(0);
    },
  );
});

describe("source admission", () => {
  test("accepts exactly the default 256 KiB and rejects one byte more before registry access", async () => {
    const code = "return 42;".padEnd(256 * 1024, " ");
    let reads = 0;

    const accepted = await execute(code);

    const rejected = await execute(code + " ", {
      get read() {
        reads++;

        return () => ToolResult.success();
      },
    });

    expect(accepted).toEqual({ result: { ok: true, value: 42 }, calls: [] });
    expect(rejected).toEqual({
      result: {
        ok: false,
        error: {
          kind: "limit",
          resource: "source",
          maximum: 262144,
          message: "Source exceeds the 262144 byte limit.",
        },
      },
      calls: [],
    });
    expect(reads).toBe(0);
  });

  test.each([
    ["ASCII", 'return "a";', 11, "a"],
    ["accent", 'return "é";', 12, "é"],
    ["emoji", 'return "😀";', 14, "😀"],
  ] as const)("measures %s source in UTF-8 bytes", async (_name, code, bytes, value) => {
    const accepted = await execute(code, {}, { maxSourceBytes: bytes });
    const rejected = await execute(code, {}, { maxSourceBytes: bytes - 1 });

    expect(accepted).toEqual({ result: { ok: true, value }, calls: [] });
    expect(rejected).toEqual({
      result: {
        ok: false,
        error: {
          kind: "limit",
          resource: "source",
          maximum: bytes - 1,
          message: `Source exceeds the ${bytes - 1} byte limit.`,
        },
      },
      calls: [],
    });
  });

  test("allows increasing the source limit without configuring VM limits", async () => {
    const code = "return 42;".padEnd(256 * 1024 + 1, " ");

    const report = await execute(code, {}, { maxSourceBytes: 512 * 1024 });

    expect(report).toEqual({ result: { ok: true, value: 42 }, calls: [] });
  });

  test("honors pre-aborted cancellation before source admission", async () => {
    const report = await execute(
      "return 42;",
      {},
      { maxSourceBytes: 1, signal: AbortSignal.abort() },
    );

    expect(report).toEqual({
      result: { ok: false, error: { kind: "cancelled", message: "Execution cancelled." } },
      calls: [],
    });
  });

  test("rejects oversized invalid syntax before parsing and permits the next execution", async () => {
    const rejected = await execute("return (;", {}, { maxSourceBytes: 1 });
    const recovered = await execute("return 42;");

    expect(rejected.result).toMatchObject({
      ok: false,
      error: { kind: "limit", resource: "source" },
    });
    expect(rejected.calls).toEqual([]);
    expect(recovered).toEqual({ result: { ok: true, value: 42 }, calls: [] });
  });
});

describe("worker VM limits", () => {
  test("executes at the maximum supported stack limit", async () => {
    const report = await execute("return 42;", {}, { maxStackSizeBytes: 4 * 1024 * 1024 });

    expect(report).toEqual({ result: { ok: true, value: 42 }, calls: [] });
  });

  test.each([
    ["memory", { memoryLimitBytes: 1 }],
    ["stack", { maxStackSizeBytes: 1024 }],
  ] as const)(
    "rejects prelude setup failure under a tiny %s limit and recovers",
    async (_name, options) => {
      const failure = await executionErrorOf(execute("return 42;", {}, options));

      expect(failure.calls).toEqual([]);
      expect(failure.cause).toBeInstanceOf(Error);
      if (failure.cause instanceof Error) {
        expect(failure.cause.message).toBe(
          "Sandbox worker execution failed. Internal error details are not transferred.",
        );
      }

      expect(await execute("return 42;")).toEqual({ result: { ok: true, value: 42 }, calls: [] });
    },
  );

  test("applies a memory override and isolates it from subsequent executions", async () => {
    const code = "return new ArrayBuffer(2 * 1024 * 1024).byteLength;";

    const limited = await execute(code, {}, { memoryLimitBytes: 1024 * 1024 });
    const increased = await execute(code, {}, { memoryLimitBytes: 4 * 1024 * 1024 });
    const defaults = await execute(code);

    expect(limited.result).toMatchObject({
      ok: false,
      error: { kind: "script" },
    });
    if (!limited.result.ok) expect(limited.result.error.message.length).toBeGreaterThan(0);

    expect(limited.calls).toEqual([]);
    expect(increased).toEqual({ result: { ok: true, value: 2097152 }, calls: [] });
    expect(defaults).toEqual({ result: { ok: true, value: 2097152 }, calls: [] });
  });

  test("applies a stack override while preserving catchable guest recursion errors", async () => {
    const code = `
      let depth = 0;
      function recurse() { depth++; recurse(); }
      try { recurse(); } catch (error) {
        if (error.name !== "RangeError" && error.name !== "InternalError") throw error;
      }
      return depth;
    `;

    const lower = await execute(code, {}, { maxStackSizeBytes: 64 * 1024 });
    const higher = await execute(code, {}, { maxStackSizeBytes: 256 * 1024 });

    expect(lower.result.ok).toBe(true);
    expect(higher.result.ok).toBe(true);
    if (!lower.result.ok || !higher.result.ok) return;

    expect(typeof lower.result.value).toBe("number");
    expect(typeof higher.result.value).toBe("number");
    if (typeof lower.result.value !== "number" || typeof higher.result.value !== "number") return;

    expect(lower.result.value).toBeGreaterThan(0);
    expect(higher.result.value).toBeGreaterThan(lower.result.value);
    expect((await execute("return 42;")).result).toEqual({ ok: true, value: 42 });
  });
});
