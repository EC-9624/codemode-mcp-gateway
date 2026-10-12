import { describe, expect, test } from "bun:test";
import { CodemodeSandbox, ToolResult } from "@cmg/codemode";
import { executionErrorOf } from "../support/execution-error.ts";

describe("source admission", () => {
  test("accepts exactly the default 256 KiB and rejects one byte more before tool dispatch", async () => {
    const code = "return await tools.read();".padEnd(256 * 1024, " ");
    let reads = 0;

    const sandbox = new CodemodeSandbox({
      tools: {
        read: () => {
          reads++;

          return ToolResult.success(42);
        },
      },
    });

    const accepted = await sandbox.execute(code);
    const rejected = await sandbox.execute(code + " ");

    expect(accepted).toEqual({
      result: { ok: true, value: 42 },
      calls: [{ callId: 1, name: "read", status: "completed", result: { ok: true, json: "42" } }],
    });
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
    expect(reads).toBe(1);
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
