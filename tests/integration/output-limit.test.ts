import { describe, expect, test } from "bun:test";
import { execute, ToolResult } from "../../src/codemode";

describe("guest output limit", () => {
  test("accepts exactly 256 KiB of JSON by default and rejects one byte more", async () => {
    const accepted = await execute('return "x".repeat(262142);');
    const rejected = await execute('return "x".repeat(262143);');

    expect(accepted.result).toEqual({ ok: true, value: "x".repeat(262142) });
    expect(rejected).toEqual({
      result: {
        ok: false,
        error: {
          kind: "limit",
          resource: "output",
          maximum: 262144,
          message: "Output exceeds the 262144 byte limit.",
        },
      },
      calls: [],
    });
  });

  test("allows increasing the limit and restores defaults for the next execution", async () => {
    const code = 'return "x".repeat(262143);';

    const increased = await execute(code, {}, { maxOutputBytes: 512 * 1024 });
    const defaults = await execute(code);

    expect(increased.result).toEqual({ ok: true, value: "x".repeat(262143) });
    expect(defaults.result).toMatchObject({
      ok: false,
      error: { kind: "limit", resource: "output", maximum: 262144 },
    });
  });

  test.each([
    ["ASCII string", 'return "abc";', 5, "abc"],
    ["multibyte string", 'return "é😀";', 8, "é😀"],
    ["escaped newline", 'return "\\n";', 4, "\n"],
    ["object", "return { a: 1 };", 7, { a: 1 }],
    ["undefined normalized to null", "return undefined;", 4, null],
  ] as const)("measures %s as serialized UTF-8 JSON", async (_name, code, bytes, value) => {
    const accepted = await execute(code, {}, { maxOutputBytes: bytes });
    const rejected = await execute(code, {}, { maxOutputBytes: bytes - 1 });

    expect(accepted.result).toEqual({ ok: true, value });
    expect(rejected.result).toEqual({
      ok: false,
      error: {
        kind: "limit",
        resource: "output",
        maximum: bytes - 1,
        message: `Output exceeds the ${bytes - 1} byte limit.`,
      },
    });
  });

  test("accepts a one-byte return value with the minimum limit", async () => {
    const report = await execute("return 1;", {}, { maxOutputBytes: 1 });

    expect(report).toEqual({ result: { ok: true, value: 1 }, calls: [] });
  });

  test.each([
    ["Error", 'throw new Error("é😀");'],
    ["string", 'throw "é😀";'],
    ["message getter", 'throw { get message() { return "é😀"; } };'],
  ] as const)("bounds a thrown %s by raw message bytes", async (_name, code) => {
    const accepted = await execute(code, {}, { maxOutputBytes: 6 });
    const rejected = await execute(code, {}, { maxOutputBytes: 5 });

    expect(accepted.result).toEqual({ ok: false, error: { kind: "script", message: "é😀" } });
    expect(rejected).toEqual({
      result: {
        ok: false,
        error: {
          kind: "limit",
          resource: "output",
          maximum: 5,
          message: "Output exceeds the 5 byte limit.",
        },
      },
      calls: [],
    });
  });

  test("bounds generated large error messages by default and recovers", async () => {
    const rejected = await execute('throw new Error("x".repeat(262145));');

    expect(rejected).toEqual({
      result: {
        ok: false,
        error: {
          kind: "limit",
          resource: "output",
          maximum: 262144,
          message: "Output exceeds the 262144 byte limit.",
        },
      },
      calls: [],
    });
    expect(await execute("return 42;")).toEqual({ result: { ok: true, value: 42 }, calls: [] });
  });

  test.each([
    ["syntax error", "return (;"],
    ["conversion error", "return 1n;"],
    ["stalled promise", "return new Promise(() => {});"],
  ] as const)("also bounds the %s message", async (_name, code) => {
    const report = await execute(code, {}, { maxOutputBytes: 1 });

    expect(report.result).toEqual({
      ok: false,
      error: {
        kind: "limit",
        resource: "output",
        maximum: 1,
        message: "Output exceeds the 1 byte limit.",
      },
    });
  });

  test("preserves timeout classification even when its diagnostic exceeds the output limit", async () => {
    const report = await execute("while (true) {}", {}, { maxOutputBytes: 1, timeoutMs: 20 });

    expect(report.result).toEqual({
      ok: false,
      error: { kind: "timeout", message: "Execution exceeded the 20 ms limit." },
    });
  });

  test("allows processing large tool payloads into small final output", async () => {
    let received = 0;

    const report = await execute(
      'return (await tools.echo("x".repeat(1048576))).length;',
      {
        echo: (args) => {
          if (typeof args !== "string") return ToolResult.failure("Expected text");

          received = args.length;

          return ToolResult.success(args);
        },
      },
      { maxOutputBytes: 7 },
    );

    expect(received).toBe(1048576);
    expect(report.result).toEqual({ ok: true, value: 1048576 });
    expect(report.calls).toHaveLength(1);
    const call = report.calls[0];
    expect(call?.status).toBe("completed");
    if (call?.status === "completed" && call.result.ok) {
      expect(call.result.json?.length).toBe(1048578);
    }
  });

  test("serializes once and drains calls started by toJSON before reporting oversized output", async () => {
    let calls = 0;

    const report = await execute(
      'return { toJSON() { tools.record(); return "xxxx"; } };',
      {
        record: () => {
          calls++;

          return ToolResult.success(42);
        },
      },
      { maxOutputBytes: 5 },
    );

    expect(calls).toBe(1);
    expect(report).toEqual({
      result: {
        ok: false,
        error: {
          kind: "limit",
          resource: "output",
          maximum: 5,
          message: "Output exceeds the 5 byte limit.",
        },
      },
      calls: [{ callId: 1, name: "record", status: "completed", result: { ok: true, json: "42" } }],
    });
  });

  test("retains completed calls and interrupts pending calls when an error message is oversized", async () => {
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));
    const signals: AbortSignal[] = [];
    let conversions = 0;

    const report = await execute(
      'await tools.done(); tools.pending(); throw new Error("x".repeat(100));',
      {
        done: () => ToolResult.success(42),
        pending: (_args, { signal }) => {
          signals.push(signal);

          return late.promise;
        },
      },
      { maxOutputBytes: 5 },
    );

    expect(report).toEqual({
      result: {
        ok: false,
        error: {
          kind: "limit",
          resource: "output",
          maximum: 5,
          message: "Output exceeds the 5 byte limit.",
        },
      },
      calls: [
        { callId: 1, name: "done", status: "completed", result: { ok: true, json: "42" } },
        { callId: 2, name: "pending", status: "interrupted", reason: "output-limit" },
      ],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);

    late.resolve(
      ToolResult.success({
        toJSON() {
          conversions++;

          return 42;
        },
      }),
    );
    await Bun.sleep(0);

    expect(conversions).toBe(0);
    expect(report.calls[1]).toEqual({
      callId: 2,
      name: "pending",
      status: "interrupted",
      reason: "output-limit",
    });
  });
});
