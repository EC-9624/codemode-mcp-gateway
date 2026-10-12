import { describe, expect, test } from "bun:test";
import { CodemodeSandbox, ToolResult, type SandboxOptions } from "../../src/codemode";
import { executionErrorOf } from "../support/execution-error";
import { rejectionOf } from "../support/rejection";

const maximums = [
  ["timeoutMs", 2147483647],
  ["totalTimeoutMs", 2147483647],
  ["memoryLimitBytes", 2147483647],
  ["maxStackSizeBytes", 4194304],
  ["maxSourceBytes", 2147483647],
  ["maxOutputBytes", 2147483647],
  ["maxToolCalls", 2147483647],
  ["maxConcurrentToolCalls", 2147483647],
] as const;

const invalidOptions = [
  ...maximums.flatMap(([name, maximum]) =>
    (
      [
        ["zero", 0],
        ["negative", -1],
        ["fractional", 1.5],
        ["NaN", NaN],
        ["infinite", Infinity],
        ["overflowing", maximum + 1],
        ["null", null],
      ] as const
    ).map(([label, value]) => ({ name, maximum, label, value })),
  ),
  { name: "maxStackSizeBytes", maximum: 4194304, label: "8 MiB", value: 8 * 1024 * 1024 },
  { name: "maxStackSizeBytes", maximum: 4194304, label: "2147483647", value: 2147483647 },
  { name: "maxStackSizeBytes", maximum: 4194304, label: "2 ** 31", value: 2 ** 31 },
];

describe("sandbox configuration validation", () => {
  test.each(invalidOptions)(
    "rejects $label $name during construction before registry access",
    async ({ name, maximum, value }) => {
      let reads = 0;

      const options: SandboxOptions = {
        tools: {
          get read() {
            reads++;

            return () => ToolResult.success();
          },
        },
      };

      // Strict TypeScript rejects null here; JavaScript callers can still send it.
      Object.assign(options, { [name]: value });

      const failure = (
        await rejectionOf(Promise.resolve().then(() => new CodemodeSandbox(options)))
      ).reason;

      expect(failure).toBeInstanceOf(RangeError);
      if (failure instanceof RangeError) {
        expect(failure.message).toBe(`${name} must be an integer from 1 to ${maximum}.`);
      }

      expect(reads).toBe(0);
    },
  );
});

describe("source admission", () => {
  test("accepts exactly the default 256 KiB and rejects one byte more before tool dispatch", async () => {
    const code = "return 42;".padEnd(256 * 1024, " ");
    let reads = 0;

    const sandbox = new CodemodeSandbox({
      tools: {
        read: () => {
          reads++;

          return ToolResult.success();
        },
      },
    });

    const accepted = await sandbox.execute(code);
    const rejected = await sandbox.execute(code + " ");

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
    const accepted = await new CodemodeSandbox({ maxSourceBytes: bytes }).execute(code);
    const rejected = await new CodemodeSandbox({ maxSourceBytes: bytes - 1 }).execute(code);

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

    const report = await new CodemodeSandbox({ maxSourceBytes: 512 * 1024 }).execute(code);

    expect(report).toEqual({ result: { ok: true, value: 42 }, calls: [] });
  });

  test("honors pre-aborted cancellation before source admission", async () => {
    const report = await new CodemodeSandbox({ maxSourceBytes: 1 }).execute("return 42;", {
      signal: AbortSignal.abort(),
    });

    expect(report).toEqual({
      result: { ok: false, error: { kind: "cancelled", message: "Execution cancelled." } },
      calls: [],
    });
  });

  test("rejects oversized invalid syntax before parsing and permits the next execution", async () => {
    const rejected = await new CodemodeSandbox({ maxSourceBytes: 1 }).execute("return (;");
    const recovered = await new CodemodeSandbox().execute("return 42;");

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
    const report = await new CodemodeSandbox({ maxStackSizeBytes: 4 * 1024 * 1024 }).execute(
      "return 42;",
    );

    expect(report).toEqual({ result: { ok: true, value: 42 }, calls: [] });
  });

  test.each([
    ["memory", { memoryLimitBytes: 1 }],
    ["stack", { maxStackSizeBytes: 1024 }],
  ] as const)(
    "rejects prelude setup failure under a tiny %s limit and recovers",
    async (_name, options) => {
      const failure = await executionErrorOf(new CodemodeSandbox(options).execute("return 42;"));

      expect(failure.calls).toEqual([]);
      expect(failure.cause).toBeInstanceOf(Error);
      if (failure.cause instanceof Error) {
        expect(failure.cause.message).toBe(
          "Sandbox worker execution failed. Internal error details are not transferred.",
        );
      }

      expect(await new CodemodeSandbox().execute("return 42;")).toEqual({
        result: { ok: true, value: 42 },
        calls: [],
      });
    },
  );

  test("isolates memory limits between sandbox instances", async () => {
    const code = "return new ArrayBuffer(2 * 1024 * 1024).byteLength;";

    const limited = await new CodemodeSandbox({ memoryLimitBytes: 1024 * 1024 }).execute(code);

    const increased = await new CodemodeSandbox({ memoryLimitBytes: 4 * 1024 * 1024 }).execute(
      code,
    );

    const defaults = await new CodemodeSandbox().execute(code);

    expect(limited.result).toMatchObject({
      ok: false,
      error: { kind: "script" },
    });
    if (!limited.result.ok) expect(limited.result.error.message.length).toBeGreaterThan(0);

    expect(limited.calls).toEqual([]);
    expect(increased).toEqual({ result: { ok: true, value: 2097152 }, calls: [] });
    expect(defaults).toEqual({ result: { ok: true, value: 2097152 }, calls: [] });
  });

  test("applies configured stack limits while preserving catchable guest recursion errors", async () => {
    const code = `
      let depth = 0;
      function recurse() { depth++; recurse(); }
      try { recurse(); } catch (error) {
        if (error.name !== "RangeError" && error.name !== "InternalError") throw error;
      }
      return depth;
    `;

    const lower = await new CodemodeSandbox({ maxStackSizeBytes: 64 * 1024 }).execute(code);
    const higher = await new CodemodeSandbox({ maxStackSizeBytes: 256 * 1024 }).execute(code);

    expect(lower.result.ok).toBe(true);
    expect(higher.result.ok).toBe(true);
    if (!lower.result.ok || !higher.result.ok) return;

    expect(typeof lower.result.value).toBe("number");
    expect(typeof higher.result.value).toBe("number");
    if (typeof lower.result.value !== "number" || typeof higher.result.value !== "number") return;

    expect(lower.result.value).toBeGreaterThan(0);
    expect(higher.result.value).toBeGreaterThan(lower.result.value);
    expect((await new CodemodeSandbox().execute("return 42;")).result).toEqual({
      ok: true,
      value: 42,
    });
  });
});
