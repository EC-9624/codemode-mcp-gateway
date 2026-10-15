import { describe, expect, test } from "bun:test";
import { CodeExecutor, ToolResult, type SandboxOptions } from "@cmg/codemode";
import { executionErrorOf } from "./support/execution-error.ts";

describe("CodeExecutor limit configuration", () => {
  test("recovers from an allocation failure while preparing an undispatched tool call", async () => {
    const sandbox = new CodeExecutor({
      memoryLimitBytes: 262144,
      tools: { read: () => ToolResult.success(42) },
    });

    const report = await sandbox.execute(`
      let held = [];
      let failed = false;
      try { while (true) held.push(new Uint8Array(160)); } catch {}
      try { await tools.read(); } catch { failed = true; }
      held = null;
      return { failed, value: await tools.read() };
    `);

    expect(report).toEqual({
      result: { ok: true, value: { failed: true, value: 42 } },
      calls: [{ callId: 1, name: "read", status: "completed" }],
    });
  });
  test.each([
    ["null", null],
    ["string", "1"],
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", NaN],
    ["infinite", Infinity],
  ] as const)("rejects a %s limit before reading tool bindings", (_name, value) => {
    let reads = 0;

    const options: SandboxOptions = {
      get tools() {
        reads++;

        return {};
      },
    };

    Object.assign(options, { maxToolCalls: value });

    expect(() => new CodeExecutor(options)).toThrow(RangeError);
    expect(reads).toBe(0);
  });

  for (const [name, maximum] of [
    ["timeoutMs", 2147483647],
    ["totalTimeoutMs", 2147483647],
    ["memoryLimitBytes", 2147483647],
    ["maxStackSizeBytes", 4194304],
    ["maxSourceBytes", 2147483647],
    ["maxOutputBytes", 2147483647],
    ["maxToolCalls", 2147483647],
    ["maxConcurrentToolCalls", 2147483647],
    ["maxConcurrentExecutions", 2147483647],
  ] as const) {
    test(`accepts ${name} at the minimum of 1`, () => {
      const options = { [name]: 1 };

      expect(() => new CodeExecutor(options)).not.toThrow();
    });

    test(`accepts ${name} at the maximum of ${maximum}`, () => {
      const options = { [name]: maximum };

      expect(() => new CodeExecutor(options)).not.toThrow();
    });

    test(`rejects ${name} above its maximum of ${maximum}`, () => {
      const options = { [name]: maximum + 1 };

      expect(() => new CodeExecutor(options)).toThrow(
        new RangeError(`${name} must be an integer from 1 to ${maximum}.`),
      );
    });
  }

  test("does not treat a null optional total deadline as absent", () => {
    const options: SandboxOptions = {};
    Object.assign(options, { totalTimeoutMs: null });

    expect(() => new CodeExecutor(options)).toThrow(RangeError);
  });

  test.each([null, "1", 0, -1, 1.5, NaN, Infinity])(
    "rejects execution capacity %s before reading tools",
    (value) => {
      let reads = 0;

      const options: SandboxOptions = {
        get tools() {
          reads++;

          return {};
        },
      };

      Object.assign(options, { maxConcurrentExecutions: value });

      expect(() => new CodeExecutor(options)).toThrow(
        new RangeError("maxConcurrentExecutions must be an integer from 1 to 2147483647."),
      );
      expect(reads).toBe(0);
    },
  );
});

describe("source admission", () => {
  test("accepts source exactly at the default 256 KiB limit", async () => {
    const code = "return await tools.read();".padEnd(256 * 1024, " ");
    let reads = 0;

    const sandbox = new CodeExecutor({
      tools: {
        read: () => {
          reads++;

          return ToolResult.success(42);
        },
      },
    });

    const accepted = await sandbox.execute(code);

    expect(accepted).toEqual({
      result: { ok: true, value: 42 },
      calls: [{ callId: 1, name: "read", status: "completed" }],
    });
    expect(reads).toBe(1);
  });

  test("rejects source one byte above the default limit before dispatching a tool", async () => {
    const code = "return await tools.read();".padEnd(262145, " ");
    let reads = 0;

    const sandbox = new CodeExecutor({
      tools: {
        read: () => {
          reads++;

          return ToolResult.success(42);
        },
      },
    });

    const report = await sandbox.execute(code);

    expect(report).toEqual({
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

  test("accepts multibyte source whose UTF-8 encoding exactly fits the limit", async () => {
    const sandbox = new CodeExecutor({ maxSourceBytes: 16 });

    const report = await sandbox.execute('return "é😀";');

    expect(report).toEqual({ result: { ok: true, value: "é😀" }, calls: [] });
  });

  test("rejects multibyte source whose characters fit but UTF-8 bytes exceed the limit", async () => {
    const sandbox = new CodeExecutor({ maxSourceBytes: 15 });

    const report = await sandbox.execute('return "é😀";');

    expect(report).toEqual({
      result: {
        ok: false,
        error: {
          kind: "limit",
          resource: "source",
          maximum: 15,
          message: "Source exceeds the 15 byte limit.",
        },
      },
      calls: [],
    });
  });

  test("allows increasing the source limit without configuring VM limits", async () => {
    const code = "return 42;".padEnd(256 * 1024 + 1, " ");

    const report = await new CodeExecutor({ maxSourceBytes: 512 * 1024 }).execute(code);

    expect(report).toEqual({ result: { ok: true, value: 42 }, calls: [] });
  });

  test("honors pre-aborted cancellation before source admission", async () => {
    const report = await new CodeExecutor({ maxSourceBytes: 1 }).execute("return 42;", {
      signal: AbortSignal.abort(),
    });

    expect(report).toEqual({
      result: { ok: false, error: { kind: "cancelled", message: "Execution cancelled." } },
      calls: [],
    });
  });

  test("rejects oversized invalid syntax before parsing and permits the next execution", async () => {
    const sandbox = new CodeExecutor({ maxSourceBytes: 10 });

    const rejected = await sandbox.execute("return (;".padEnd(11, " "));
    const recovered = await sandbox.execute("return 42;");

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
    const report = await new CodeExecutor({ maxStackSizeBytes: 4 * 1024 * 1024 }).execute(
      "return 42;",
    );

    expect(report).toEqual({ result: { ok: true, value: 42 }, calls: [] });
  });

  test.each([
    ["memory", { memoryLimitBytes: 1 }],
    ["stack", { maxStackSizeBytes: 1024 }],
  ] as const)(
    "rejects setup under a tiny %s limit without affecting a healthy executor",
    async (_name, options) => {
      const failure = await executionErrorOf(new CodeExecutor(options).execute("return 42;"));

      expect(failure.calls).toEqual([]);
      expect(failure.cause).toBeInstanceOf(Error);
      if (failure.cause instanceof Error) {
        expect(failure.cause.message).toBe(
          "Sandbox worker execution failed. Internal error details are not transferred.",
        );
      }

      expect(await new CodeExecutor().execute("return 42;")).toEqual({
        result: { ok: true, value: 42 },
        calls: [],
      });
    },
  );

  test("isolates memory limits between sandbox instances", async () => {
    const code = "return new ArrayBuffer(2 * 1024 * 1024).byteLength;";

    const limited = await new CodeExecutor({ memoryLimitBytes: 1024 * 1024 }).execute(code);

    const increased = await new CodeExecutor({ memoryLimitBytes: 4 * 1024 * 1024 }).execute(code);

    const defaults = await new CodeExecutor().execute(code);

    expect(limited.result).toMatchObject({
      ok: false,
      error: { kind: "script" },
    });
    if (!limited.result.ok) expect(limited.result.error.message.length).toBeGreaterThan(0);

    expect(limited.calls).toEqual([]);
    expect(increased).toEqual({ result: { ok: true, value: 2097152 }, calls: [] });
    expect(defaults).toEqual({ result: { ok: true, value: 2097152 }, calls: [] });
  });

  test("can catch guest allocation failure and continue in the same execution", async () => {
    const report = await new CodeExecutor().execute(`
      let failed = false;
      try { new ArrayBuffer(128 * 1024 * 1024); } catch { failed = true; }
      return { failed, value: 1 + 2 };
    `);

    expect(report).toEqual({ result: { ok: true, value: { failed: true, value: 3 } }, calls: [] });
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

    const lower = await new CodeExecutor({ maxStackSizeBytes: 64 * 1024 }).execute(code);
    const higher = await new CodeExecutor({ maxStackSizeBytes: 256 * 1024 }).execute(code);

    expect(lower.result.ok).toBe(true);
    expect(higher.result.ok).toBe(true);
    if (!lower.result.ok || !higher.result.ok)
      throw new Error("Expected both recursion errors to be caught");

    expect(typeof lower.result.value).toBe("number");
    expect(typeof higher.result.value).toBe("number");
    if (typeof lower.result.value !== "number" || typeof higher.result.value !== "number") {
      throw new Error("Expected numeric recursion depths");
    }

    expect(lower.result.value).toBeGreaterThan(0);
    expect(higher.result.value).toBeGreaterThan(lower.result.value);
    expect((await new CodeExecutor().execute("return 42;")).result).toEqual({
      ok: true,
      value: 42,
    });
  });
});
