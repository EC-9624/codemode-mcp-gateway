import { describe, expect, test } from "bun:test";
import { isMainThread } from "node:worker_threads";
import { CodeExecutor, ToolResult } from "@cmg/codemode";

describe("CodeExecutor reports", () => {
  test("records responses in invocation order even when replies finish in reverse order", async () => {
    const second = Promise.withResolvers<void>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => second.resolve());
    const order: number[] = [];

    const report = await new CodeExecutor({
      tools: {
        read: async (args) => {
          if (args === 1) await second.promise;

          if (typeof args !== "number") return ToolResult.failure("Expected a number");

          order.push(args);
          if (args === 2) second.resolve();

          return ToolResult.success(args);
        },
      },
    }).execute("return await Promise.all([tools.read(1), tools.read(2)]);");

    expect(order).toEqual([2, 1]);
    expect(report).toEqual({
      result: { ok: true, value: [1, 2] },
      calls: [
        { callId: 1, name: "read", status: "completed", result: { ok: true, json: "1" } },
        { callId: 2, name: "read", status: "completed", result: { ok: true, json: "2" } },
      ],
    });
  });

  test("serializes once on the main thread and retains detached public responses", async () => {
    let conversions = 0;
    const value = { nested: { amount: 42 } };

    const report = await new CodeExecutor({
      tools: {
        read: () =>
          ToolResult.success({
            toJSON() {
              expect(isMainThread).toBe(true);
              conversions++;

              return value;
            },
          }),
      },
    }).execute("const value = await tools.read(); value.nested.amount = 99; return value;");

    expect(value.nested.amount).toBe(42);
    value.nested.amount = 100;

    expect(conversions).toBe(1);
    expect(report).toEqual({
      result: { ok: true, value: { nested: { amount: 99 } } },
      calls: [
        {
          callId: 1,
          name: "read",
          status: "completed",
          result: { ok: true, json: '{"nested":{"amount":42}}' },
        },
      ],
    });
  });

  test("keeps call IDs and responses separate across concurrent executions", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => release.resolve());
    let calls = 0;

    const completions = [1, 2].map((value) =>
      new CodeExecutor({
        tools: {
          read: async () => {
            if (++calls === 2) started.resolve();

            await release.promise;

            return ToolResult.success(value);
          },
        },
      }).execute("return await tools.read();"),
    );

    await started.promise;
    release.resolve();
    const reports = await Promise.all(completions);

    expect(reports).toEqual([
      {
        result: { ok: true, value: 1 },
        calls: [{ callId: 1, name: "read", status: "completed", result: { ok: true, json: "1" } }],
      },
      {
        result: { ok: true, value: 2 },
        calls: [{ callId: 1, name: "read", status: "completed", result: { ok: true, json: "2" } }],
      },
    ]);
  });

  test("retains undefined distinctly from null", async () => {
    const received: unknown[] = [];

    const report = await new CodeExecutor({
      tools: {
        echo: (args) => {
          received.push(args);

          return ToolResult.success(args);
        },
      },
    }).execute("return [(await tools.echo()) === undefined, await tools.echo(null)];");

    expect(received).toEqual([undefined, null]);
    expect(report).toEqual({
      result: { ok: true, value: [true, null] },
      calls: [
        { callId: 1, name: "echo", status: "completed", result: { ok: true, json: undefined } },
        { callId: 2, name: "echo", status: "completed", result: { ok: true, json: "null" } },
      ],
    });
    const call = report.calls[0];
    if (call?.status === "completed") expect(Object.hasOwn(call.result, "json")).toBe(true);
  });

  test("retains only public failure fields even when the guest catches the failure", async () => {
    const failure = {
      ok: false,
      error: { message: "Public failure", diagnostics: () => "Private details" },
      privateCallback: () => {},
    } as const;

    const report = await new CodeExecutor({
      tools: {
        read: () => failure,
      },
    }).execute("try { await tools.read(); } catch (error) { return error.message; }");

    expect(report).toEqual({
      result: { ok: true, value: "Public failure" },
      calls: [
        {
          callId: 1,
          name: "read",
          status: "completed",
          result: { ok: false, error: { message: "Public failure" } },
        },
      ],
    });
  });

  test("retains a generic response for thrown host errors without private details", async () => {
    const report = await new CodeExecutor({
      tools: {
        read: () => {
          throw new Error("Private credentials");
        },
      },
    }).execute("return await tools.read();");

    expect(report).toEqual({
      result: { ok: false, error: { kind: "script", message: "Host tool failed." } },
      calls: [
        {
          callId: 1,
          name: "read",
          status: "completed",
          result: { ok: false, error: { message: "Host tool failed." } },
        },
      ],
    });
  });

  test("retains the conversion failure response rather than an unserializable host value", async () => {
    const report = await new CodeExecutor({
      tools: {
        read: () => ToolResult.success(1n),
      },
    }).execute("return await tools.read();");

    expect(report).toEqual({
      result: {
        ok: false,
        error: { kind: "script", message: "Tool result is not JSON-serializable." },
      },
      calls: [
        {
          callId: 1,
          name: "read",
          status: "completed",
          result: { ok: false, error: { message: "Tool result is not JSON-serializable." } },
        },
      ],
    });
  });

  test("retains completed work and records cancellation for the interrupted call", async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));
    let conversions = 0;

    const completion = new CodeExecutor({
      tools: {
        create: () => ToolResult.success({ id: "invoice-1" }),
        send: () => {
          started.resolve();

          return late.promise;
        },
      },
    }).execute("await tools.create(); return await tools.send();", { signal: controller.signal });

    await started.promise;
    controller.abort("Private reason");
    const report = await completion;

    const expected = {
      result: { ok: false, error: { kind: "cancelled", message: "Execution cancelled." } },
      calls: [
        {
          callId: 1,
          name: "create",
          status: "completed",
          result: { ok: true, json: '{"id":"invoice-1"}' },
        },
        { callId: 2, name: "send", status: "interrupted", reason: "cancelled" },
      ],
    } as const;

    expect(report).toEqual(expected);

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
    expect(report).toEqual(expected);
  });

  test("retains earlier responses and an unawaited pending call after a script throws", async () => {
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));
    const signals: AbortSignal[] = [];

    const sandbox = new CodeExecutor({
      tools: {
        done: () => ToolResult.success(42),
        pending: (_args, { signal }) => {
          signals.push(signal);

          return late.promise;
        },
      },
    });

    const report = await sandbox.execute(
      "await tools.done(); tools.pending(); throw new Error('failed');",
    );

    expect(report).toEqual({
      result: { ok: false, error: { kind: "script", message: "failed" } },
      calls: [
        { callId: 1, name: "done", status: "completed", result: { ok: true, json: "42" } },
        { callId: 2, name: "pending", status: "interrupted", reason: "script-error" },
      ],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    late.resolve(ToolResult.success(7));
    expect((await sandbox.execute("return await tools.done();")).result).toEqual({
      ok: true,
      value: 42,
    });
  });

  test("retains earlier responses and a pending call after the guest deadline expires", async () => {
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
      },
      timeoutMs: 100,
    }).execute("await tools.done(); return await tools.pending();");

    expect(report).toEqual({
      result: {
        ok: false,
        error: { kind: "timeout", message: "Execution exceeded the 100 ms limit." },
      },
      calls: [
        { callId: 1, name: "done", status: "completed", result: { ok: true, json: "42" } },
        { callId: 2, name: "pending", status: "interrupted", reason: "timeout" },
      ],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });
});
