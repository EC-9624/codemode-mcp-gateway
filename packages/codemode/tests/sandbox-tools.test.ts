import { describe, expect, test } from "bun:test";
import { CodeExecutor, ToolResult } from "@cmg/codemode";

describe("CodeExecutor tools", () => {
  test("lets the script catch public host errors and continue", async () => {
    const sandbox = new CodeExecutor({
      tools: {
        answer: () => ToolResult.success(3),
        fail: async () => ToolResult.failure("An expected failure"),
      },
    });

    const report = await sandbox.execute(`
      try { await tools.fail(); } catch (error) {
        return { error: error.message, value: await tools.answer() };
      }
    `);

    expect(report.result).toEqual({ ok: true, value: { error: "An expected failure", value: 3 } });
  });

  test("keeps an asynchronous non-Error host rejection private", async () => {
    const report = await new CodeExecutor({
      tools: {
        fail: async () => {
          await Bun.sleep(0);
          throw "Private string";
        },
      },
    }).execute("return await tools.fail();");

    expect(report.result).toEqual({
      ok: false,
      error: { kind: "script", message: "Host tool failed." },
    });
  });

  test("does not interpret failure-shaped tool data as a bridge failure", async () => {
    const value = { ok: false, error: { message: "Ordinary data" } };
    const sandbox = new CodeExecutor({ tools: { read: () => ToolResult.success(value) } });

    const report = await sandbox.execute("return await tools.read();");

    expect(report.result).toEqual({ ok: true, value });
  });

  for (const scenario of [
    { name: "unawaited calls", code: 'tools.write(); return "done";', value: "done" },
    {
      name: "calls started by result serialization",
      code: "return { toJSON() { tools.write(); return 3; } };",
      value: 3,
    },
  ]) {
    test(`waits for ${scenario.name} before reporting success`, async () => {
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      using cleanup = new DisposableStack();
      cleanup.defer(() => release.resolve());
      let completed = false;
      let settled = false;

      const completion = new CodeExecutor({
        tools: {
          write: async () => {
            started.resolve();
            await release.promise;
            completed = true;

            return ToolResult.success();
          },
        },
      })
        .execute(scenario.code)
        .then((result) => {
          settled = true;

          return result;
        });

      await started.promise;
      expect(settled).toBe(false);
      expect(completed).toBe(false);
      release.resolve();
      expect(await completion).toEqual({
        result: { ok: true, value: scenario.value },
        calls: [
          { callId: 1, name: "write", status: "completed", result: { ok: true, json: undefined } },
        ],
      });
      expect(completed).toBe(true);
    });
  }

  test("drains race losers without replay or automatic cancellation", async () => {
    const winnerObserved = Promise.withResolvers<unknown>();
    const releaseLoser = Promise.withResolvers<void>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => releaseLoser.resolve());
    let completed = false;
    let calls = 0;
    let settled = false;
    const signals: AbortSignal[] = [];

    const completion = new CodeExecutor({
      tools: {
        fast: () => ToolResult.success(1),
        slow: async (_args, { signal }) => {
          signals.push(signal);
          calls += 1;
          await releaseLoser.promise;
          completed = true;

          return ToolResult.success(2);
        },
        reportWinner: (winner) => {
          winnerObserved.resolve(winner);

          return ToolResult.success();
        },
      },
    })
      .execute(`
        const winner = await Promise.race([tools.fast(), tools.slow()]);
        await tools.reportWinner(winner);
        return winner;
      `)
      .then((result) => {
        settled = true;

        return result;
      });

    expect(await winnerObserved.promise).toBe(1);
    expect(settled).toBe(false);
    expect(completed).toBe(false);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    releaseLoser.resolve();
    expect((await completion).result).toEqual({ ok: true, value: 1 });
    expect(completed).toBe(true);
    expect(calls).toBe(1);
    expect(signals[0]?.aborted).toBe(false);
  });

  test("keeps JSON text distinct from the string value it encodes", async () => {
    const value = 'Hello "mcm"\n日本語';
    const sandbox = new CodeExecutor({ tools: { echo: (args) => ToolResult.success(args) } });

    const report = await sandbox.execute(`return await tools.echo(${JSON.stringify(value)});`);

    expect(report.result).toEqual({ ok: true, value });
  });

  test.each([
    ["BigInt", "return await tools.echo(1n);", "Do not know how to serialize a BigInt"],
    ["function", "return await tools.echo(() => 3);", "Tool arguments are not JSON-serializable."],
    [
      "cycle",
      "const value = {}; value.self = value; return await tools.echo(value);",
      "circular reference",
    ],
  ] as const)(
    "rejects a non-JSON %s argument before host dispatch",
    async (_name, code, message) => {
      let calls = 0;

      const report = await new CodeExecutor({
        tools: {
          echo: (args) => {
            calls += 1;

            return ToolResult.success(args);
          },
        },
      }).execute(code);

      expect(report).toEqual({
        result: { ok: false, error: { kind: "script", message } },
        calls: [],
      });
      expect(calls).toBe(0);
    },
  );

  test("rejects a function-valued host result with a public conversion error", async () => {
    const sandbox = new CodeExecutor({ tools: { read: () => ToolResult.success(() => 3) } });

    const report = await sandbox.execute("return await tools.read();");

    expect(report.result).toEqual({
      ok: false,
      error: { kind: "script", message: "Tool result is not JSON-serializable." },
    });
  });

  test("rejects a cyclic host result with a public conversion error", async () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    const sandbox = new CodeExecutor({ tools: { read: () => ToolResult.success(cycle) } });

    const report = await sandbox.execute("return await tools.read();");

    expect(report.result).toEqual({
      ok: false,
      error: { kind: "script", message: "Tool result is not JSON-serializable." },
    });
  });

  test("reads an undefined tool result value once for guest delivery and retention", async () => {
    let reads = 0;

    const report = await new CodeExecutor({
      tools: {
        read: () => ({
          ok: true,
          get value() {
            reads++;
            if (reads > 1) throw new Error("Private repeated getter failure");

            return undefined;
          },
        }),
      },
    }).execute("return (await tools.read()) === undefined;");

    expect(report).toEqual({
      result: { ok: true, value: true },
      calls: [
        { callId: 1, name: "read", status: "completed", result: { ok: true, json: undefined } },
      ],
    });
    expect(reads).toBe(1);
  });

  test("lets the guest catch a private tool result value getter failure as a conversion error", async () => {
    const report = await new CodeExecutor({
      tools: {
        read: () => ({
          ok: true,
          get value() {
            throw new Error("Private value getter failure");
          },
        }),
      },
    }).execute("try { await tools.read(); } catch (error) { return error.message; }");

    expect(report.result).toEqual({
      ok: true,
      value: "Tool result is not JSON-serializable.",
    });
  });

  test.each([
    [
      "getter",
      {
        get secret() {
          throw new Error("Private getter diagnostics");
        },
      },
    ],
    [
      "toJSON hook",
      {
        toJSON() {
          throw "Private conversion diagnostics";
        },
      },
    ],
  ] as const)("treats a throwing host %s as a conversion failure", async (_name, value) => {
    const report = await new CodeExecutor({
      tools: {
        read: () => ToolResult.success(value),
      },
    }).execute("return await tools.read();");

    expect(report.result).toEqual({
      ok: false,
      error: { kind: "script", message: "Tool result is not JSON-serializable." },
    });
  });

  test("only exposes supplied tools and no inherited host functions", async () => {
    const sandbox = new CodeExecutor({ tools: { read: () => ToolResult.success(42) } });

    const report = await sandbox.execute(
      "return [Object.keys(tools), typeof tools.toString, typeof tools.hidden];",
    );

    expect(report.result).toEqual({ ok: true, value: [["read"], "undefined", "undefined"] });
  });

  test("reports a script failure when calling an unavailable tool", async () => {
    const sandbox = new CodeExecutor({ tools: { read: () => ToolResult.success(42) } });

    const report = await sandbox.execute("return await tools.hidden();");

    expect(report.result).toMatchObject({ ok: false, error: { kind: "script" } });
    expect(report.calls).toEqual([]);
  });

  test("reports guest promises that cannot make progress", async () => {
    const sandbox = new CodeExecutor();

    const report = await sandbox.execute("return await new Promise(() => {});");

    expect(report.result).toEqual({
      ok: false,
      error: {
        kind: "script",
        message: "Script is waiting on a promise with no pending host calls.",
      },
    });
  });

  test("receives tool replies while guest jobs keep arriving", async () => {
    const sandbox = new CodeExecutor({
      tools: {
        wait: async () => {
          await Bun.sleep(5);

          return ToolResult.success();
        },
      },
    });

    const report = await sandbox.execute(`let done = false;
         const call = tools.wait().then(() => { done = true; });
         while (!done) await Promise.resolve();
         await call;
          return done;`);

    expect(report.result).toEqual({ ok: true, value: true });
  });

  test("continues executing tools after a validation failure", async () => {
    const sandbox = new CodeExecutor({
      tools: {
        add: async (args) => {
          if (
            typeof args !== "object" ||
            args === null ||
            !("a" in args) ||
            !("b" in args) ||
            typeof args.a !== "number" ||
            typeof args.b !== "number"
          ) {
            return ToolResult.failure("add expects numeric a and b.");
          }

          return ToolResult.success(args.a + args.b);
        },
      },
    });

    const succeeded = await sandbox.execute("return await tools.add({ a: 1, b: 2 });");

    const failed = await sandbox.execute("return await tools.add(null);");
    const recovered = await sandbox.execute("return await tools.add({ a: 1, b: 2 });");

    expect(succeeded.result).toEqual({ ok: true, value: 3 });
    expect(failed.result).toEqual({
      ok: false,
      error: { kind: "script", message: "add expects numeric a and b." },
    });
    expect(recovered.result).toEqual({ ok: true, value: 3 });
  });
});
