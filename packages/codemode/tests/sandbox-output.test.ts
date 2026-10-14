import { describe, expect, test } from "bun:test";
import { CodeExecutor, ToolResult } from "@cmg/codemode";

describe("CodeExecutor output limit", () => {
  test("preserves the complete thrown string when embedded NULs fit the output limit", async () => {
    const sandbox = new CodeExecutor({ maxOutputBytes: 3 });

    const report = await sandbox.execute('JSON.stringify = () => "replaced"; throw "a\\0b";');

    expect(report.result).toEqual({ ok: false, error: { kind: "script", message: "a\u0000b" } });
  });

  test("counts bytes after an embedded NUL when rejecting oversized error text", async () => {
    const sandbox = new CodeExecutor({ maxOutputBytes: 2 });

    const report = await sandbox.execute('JSON.stringify = () => "replaced"; throw "a\\0b";');

    expect(report.result).toMatchObject({
      ok: false,
      error: { kind: "limit", resource: "output", maximum: 2 },
    });
  });

  test("accepts exactly 256 KiB of serialized JSON by default", async () => {
    const sandbox = new CodeExecutor();

    const accepted = await sandbox.execute('return "x".repeat(262142);');

    expect(accepted.result).toEqual({ ok: true, value: "x".repeat(262142) });
  });

  test("rejects serialized JSON one byte above the default output limit", async () => {
    const sandbox = new CodeExecutor();

    const rejected = await sandbox.execute('return "x".repeat(262143);');

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

  test("isolates a larger output limit from another sandbox's defaults", async () => {
    const code = 'return "x".repeat(262143);';

    const increased = await new CodeExecutor({ maxOutputBytes: 512 * 1024 }).execute(code);
    const defaults = await new CodeExecutor().execute(code);

    expect(increased.result).toEqual({ ok: true, value: "x".repeat(262143) });
    expect(defaults.result).toMatchObject({
      ok: false,
      error: { kind: "limit", resource: "output", maximum: 262144 },
    });
  });

  for (const [name, code, bytes, value] of [
    ["ASCII string", 'return "abc";', 5, "abc"],
    ["multibyte string", 'return "é😀";', 8, "é😀"],
    ["escaped newline", 'return "\\n";', 4, "\n"],
    ["object", "return { a: 1 };", 7, { a: 1 }],
    ["undefined normalized to null", "return undefined;", 4, null],
  ] as const) {
    test(`accepts ${name} at its serialized UTF-8 size of ${bytes} bytes`, async () => {
      const sandbox = new CodeExecutor({ maxOutputBytes: bytes });

      const report = await sandbox.execute(code);

      expect(report.result).toEqual({ ok: true, value });
    });

    test(`rejects ${name} when the limit is below its serialized UTF-8 size of ${bytes} bytes`, async () => {
      const sandbox = new CodeExecutor({ maxOutputBytes: bytes - 1 });

      const report = await sandbox.execute(code);

      expect(report.result).toEqual({
        ok: false,
        error: {
          kind: "limit",
          resource: "output",
          maximum: bytes - 1,
          message: `Output exceeds the ${bytes - 1} byte limit.`,
        },
      });
    });
  }

  test("accepts a one-byte return value with the minimum limit", async () => {
    const report = await new CodeExecutor({ maxOutputBytes: 1 }).execute("return 1;");

    expect(report).toEqual({ result: { ok: true, value: 1 }, calls: [] });
  });

  for (const [name, code] of [
    ["Error", 'throw new Error("é😀");'],
    ["string", 'throw "é😀";'],
    ["message getter", 'throw { get message() { return "é😀"; } };'],
  ] as const) {
    test(`preserves a thrown ${name} when its raw message exactly fits the byte limit`, async () => {
      const sandbox = new CodeExecutor({ maxOutputBytes: 6 });

      const report = await sandbox.execute(code);

      expect(report.result).toEqual({ ok: false, error: { kind: "script", message: "é😀" } });
    });

    test(`rejects a thrown ${name} when its raw message exceeds the byte limit`, async () => {
      const sandbox = new CodeExecutor({ maxOutputBytes: 5 });

      const report = await sandbox.execute(code);

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
        calls: [],
      });
    });
  }

  test("bounds generated large error messages by default and recovers", async () => {
    const sandbox = new CodeExecutor();

    const rejected = await sandbox.execute('throw new Error("x".repeat(262145));');
    const recovered = await sandbox.execute("return 42;");

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
    expect(recovered).toEqual({
      result: { ok: true, value: 42 },
      calls: [],
    });
  });

  test.each([
    ["syntax error", "return (;"],
    ["conversion error", "return 1n;"],
    ["stalled promise", "return new Promise(() => {});"],
  ] as const)("also bounds the %s message", async (_name, code) => {
    const report = await new CodeExecutor({ maxOutputBytes: 1 }).execute(code);

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
    const report = await new CodeExecutor({ maxOutputBytes: 1, timeoutMs: 20 }).execute(
      "while (true) {}",
    );

    expect(report.result).toEqual({
      ok: false,
      error: { kind: "timeout", message: "Execution exceeded the 20 ms limit." },
    });
  });

  test("allows processing large tool payloads into small final output", async () => {
    let received = 0;

    const report = await new CodeExecutor({
      tools: {
        echo: (args) => {
          if (typeof args !== "string") return ToolResult.failure("Expected text");

          received = args.length;

          return ToolResult.success(args);
        },
      },
      maxOutputBytes: 7,
    }).execute('return (await tools.echo("x".repeat(1048576))).length;');

    expect(received).toBe(1048576);
    expect(report.result).toEqual({ ok: true, value: 1048576 });
    expect(report.calls).toEqual([{ callId: 1, name: "echo", status: "completed" }]);
  });

  test("serializes once and drains calls started by toJSON before reporting oversized output", async () => {
    let calls = 0;
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => release.resolve(ToolResult.success()));

    const completion = new CodeExecutor({
      tools: {
        record: () => {
          calls++;
          started.resolve();

          return release.promise;
        },
        acknowledge: (value) => ToolResult.success(value),
      },
      maxOutputBytes: 5,
    }).execute(
      'return { toJSON() { tools.record().then(value => tools.acknowledge(value)); return "xxxx"; } };',
    );

    await started.promise;
    release.resolve(ToolResult.success(42));
    const report = await completion;

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
      calls: [
        { callId: 1, name: "record", status: "completed" },
        { callId: 2, name: "acknowledge", status: "completed" },
      ],
    });
  });

  test("retains completed calls and interrupts pending calls when an error message is oversized", async () => {
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));
    const signals: AbortSignal[] = [];
    let conversions = 0;

    const report = await new CodeExecutor({
      tools: {
        done: () => ToolResult.success(42),
        pending: (_args, { signal }) => {
          signals.push(signal);

          return late.promise;
        },
      },
      maxOutputBytes: 5,
    }).execute('await tools.done(); tools.pending(); throw new Error("x".repeat(100));');

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
        { callId: 1, name: "done", status: "completed" },
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
