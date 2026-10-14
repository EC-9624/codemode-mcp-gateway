import { describe, expect, test } from "bun:test";
import { createDiscoveryTools, CodeExecutor, ToolCatalog, ToolResult } from "@cmg/codemode";

describe("CodeExecutor call budget", () => {
  test("preserves admission failure triggered by guest error conversion", async () => {
    const sandbox = new CodeExecutor({
      tools: { read: () => ToolResult.success(42) },
      maxToolCalls: 1,
      maxOutputBytes: 1,
    });

    const report = await sandbox.execute(
      'await tools.read(); throw { get message() { tools.read(); return "Guest failure"; } };',
    );

    expect(report).toEqual({
      result: {
        ok: false,
        error: {
          kind: "limit",
          resource: "tool-calls",
          maximum: 1,
          message: "Execution exceeded the 1 tool-call limit.",
        },
      },
      calls: [{ callId: 1, name: "read", status: "completed" }],
    });
  });
  test("allows the default 100 calls and stops the 101st without invoking it", async () => {
    let calls = 0;

    const report = await new CodeExecutor({
      tools: {
        read: () => ToolResult.success(++calls),
      },
    }).execute("for (let i = 0; i < 101; i++) await tools.read();");

    expect(report.result).toEqual({
      ok: false,
      error: {
        kind: "limit",
        resource: "tool-calls",
        maximum: 100,
        message: "Execution exceeded the 100 tool-call limit.",
      },
    });
    expect(calls).toBe(100);
    expect(report.calls).toHaveLength(100);
    expect(report.calls.every((call) => call.status === "completed")).toBe(true);
    expect(report.calls[99]).toEqual({
      callId: 100,
      name: "read",
      status: "completed",
    });
  });

  test("permits a larger total limit and resets counters for the next execution", async () => {
    const tools = { read: () => ToolResult.success(42) };
    const sandbox = new CodeExecutor({ tools, maxToolCalls: 101 });

    const report = await sandbox.execute(
      "for (let i = 0; i < 101; i++) await tools.read(); return 42;",
    );

    const next = await sandbox.execute("return await tools.read();");

    expect(report.result).toEqual({ ok: true, value: 42 });
    expect(report.calls).toHaveLength(101);
    expect(next).toEqual({
      result: { ok: true, value: 42 },
      calls: [{ callId: 1, name: "read", status: "completed" }],
    });
  });

  test("counts a shared promise once even when awaited repeatedly", async () => {
    let calls = 0;

    const report = await new CodeExecutor({
      tools: {
        read: () => ToolResult.success(++calls),
      },
      maxToolCalls: 1,
    }).execute("const p = tools.read(); return [await p, await p];");

    expect(report.result).toEqual({ ok: true, value: [1, 1] });
    expect(report.calls).toHaveLength(1);
    expect(calls).toBe(1);
  });

  test("does not charge argument serialization failures before admission", async () => {
    let calls = 0;

    const report = await new CodeExecutor({
      tools: {
        read: (args) => {
          calls++;

          return ToolResult.success(args);
        },
      },
      maxToolCalls: 1,
    }).execute("try { await tools.read(1n); } catch {} return await tools.read(42);");

    expect(report.result).toEqual({ ok: true, value: 42 });
    expect(report.calls).toHaveLength(1);
    expect(calls).toBe(1);
  });

  test("failed responses release concurrency but still consume total calls", async () => {
    let calls = 0;

    const report = await new CodeExecutor({
      tools: {
        read: () => {
          calls++;

          return ToolResult.failure("Public failure");
        },
      },
      maxToolCalls: 2,
      maxConcurrentToolCalls: 1,
    }).execute("for (let i = 0; i < 3; i++) { try { await tools.read(); } catch {} }");

    expect(report.result).toEqual({
      ok: false,
      error: {
        kind: "limit",
        resource: "tool-calls",
        maximum: 2,
        message: "Execution exceeded the 2 tool-call limit.",
      },
    });
    expect(calls).toBe(2);
    expect(report.calls).toEqual([
      {
        callId: 1,
        name: "read",
        status: "completed",
      },
      {
        callId: 2,
        name: "read",
        status: "completed",
      },
    ]);
  });

  test("counts discovery calls in the same budget as other tools", async () => {
    let calls = 0;

    const catalog = ToolCatalog.create({
      read: { description: "Read data", execute: () => ToolResult.success(++calls) },
    });

    const discovery = createDiscoveryTools(catalog);

    const report = await new CodeExecutor({
      tools: {
        ...catalog.tools,
        ...discovery,
      },
      maxToolCalls: 1,
    }).execute('await tools.searchTools({ query: "read" }); return await tools.read();');

    expect(report.result).toMatchObject({
      ok: false,
      error: { kind: "limit", resource: "tool-calls" },
    });
    expect(report.calls).toHaveLength(1);
    expect(report.calls[0]?.name).toBe("searchTools");
    expect(calls).toBe(0);
  });

  test("keeps completed call summaries and interrupts dispatched pending calls on exhaustion", async () => {
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));
    const signals: AbortSignal[] = [];

    const report = await new CodeExecutor({
      tools: {
        done: () => ToolResult.success(42),
        pending: (_args, { signal }) => {
          signals.push(signal);

          return late.promise;
        },
        extra: () => {
          throw new Error("Must not dispatch");
        },
      },
      maxToolCalls: 2,
    }).execute("await tools.done(); tools.pending(); tools.extra();");

    expect(report).toEqual({
      result: {
        ok: false,
        error: {
          kind: "limit",
          resource: "tool-calls",
          maximum: 2,
          message: "Execution exceeded the 2 tool-call limit.",
        },
      },
      calls: [
        { callId: 1, name: "done", status: "completed" },
        { callId: 2, name: "pending", status: "interrupted", reason: "call-limit" },
      ],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });
});

describe("concurrent tool calls", () => {
  test("stops an unawaited burst at the default 10 outstanding calls", async () => {
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));
    let calls = 0;

    const report = await new CodeExecutor({
      tools: {
        read: () => {
          calls++;

          return late.promise;
        },
      },
    }).execute("for (let i = 0; i < 10000; i++) { try { tools.read(); } catch {} }");

    expect(report.result).toEqual({
      ok: false,
      error: {
        kind: "limit",
        resource: "concurrent-tool-calls",
        maximum: 10,
        message: "Execution exceeded the 10 concurrent tool-call limit.",
      },
    });
    expect(calls).toBe(10);
    expect(report.calls).toHaveLength(10);
    expect(
      report.calls.every(
        (call) => call.status === "interrupted" && call.reason === "concurrency-limit",
      ),
    ).toBe(true);
  });

  test("allows exactly the configured overlap above the built-in default", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => release.resolve(ToolResult.success()));
    let calls = 0;

    const completion = new CodeExecutor({
      tools: {
        read: () => {
          if (++calls === 11) started.resolve();

          return release.promise;
        },
      },
      maxConcurrentToolCalls: 11,
    }).execute("await Promise.all(Array.from({length: 11}, () => tools.read())); return 42;");

    await started.promise;
    release.resolve(ToolResult.success(7));
    const report = await completion;

    expect(report.result).toEqual({ ok: true, value: 42 });
    expect(report.calls).toHaveLength(11);
    expect(report.calls.every((call) => call.status === "completed")).toBe(true);
  });

  test("reuses a single slot for sequential successful calls", async () => {
    let calls = 0;

    const report = await new CodeExecutor({
      tools: {
        read: () => ToolResult.success(++calls),
      },
      maxConcurrentToolCalls: 1,
    }).execute("for (let i = 0; i < 5; i++) await tools.read(); return 42;");

    expect(report.result).toEqual({ ok: true, value: 42 });
    expect(calls).toBe(5);
    expect(report.calls).toHaveLength(5);
  });

  test("isolates budgets between executions running at the same time", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => release.resolve(ToolResult.success()));
    let calls = 0;

    const read = () => {
      if (++calls === 2) started.resolve();

      return release.promise;
    };

    const sandbox = new CodeExecutor({
      tools: { read },
      maxToolCalls: 1,
      maxConcurrentToolCalls: 1,
    });

    const first = sandbox.execute("return await tools.read();");
    const second = sandbox.execute("return await tools.read();");

    await started.promise;
    release.resolve(ToolResult.success(42));

    expect((await first).result).toEqual({ ok: true, value: 42 });
    expect((await second).result).toEqual({ ok: true, value: 42 });
    expect(calls).toBe(2);
  });
});
