import { describe, expect, test } from "bun:test";
import { CodemodeSandbox, ToolResult, type SandboxTool } from "@cmg/codemode";

const add: SandboxTool = async (args) => {
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

  await Bun.sleep(1);

  return ToolResult.success(args.a + args.b);
};

describe("sandbox tool calls", () => {
  test("awaits a real asynchronous host operation", async () => {
    expect(
      (
        await new CodemodeSandbox({ tools: { add } }).execute(
          "return await tools.add({ a: 1, b: 2 });",
        )
      ).result,
    ).toEqual({
      ok: true,
      value: 3,
    });
  });

  test("also bridges synchronous host callbacks", async () => {
    expect(
      (
        await new CodemodeSandbox({ tools: { answer: () => ToolResult.success(42) } }).execute(
          "return await tools.answer();",
        )
      ).result,
    ).toEqual({
      ok: true,
      value: 42,
    });
  });

  test("reports uncaught tool argument validation failures as script errors", async () => {
    expect(
      (
        await new CodemodeSandbox({ tools: { add } }).execute(
          'return await tools.add({ a: "wrong", b: 2 });',
        )
      ).result,
    ).toEqual({
      ok: false,
      error: { kind: "script", message: "add expects numeric a and b." },
    });
  });

  test("lets the script catch public host errors and continue", async () => {
    expect(
      (
        await new CodemodeSandbox({
          tools: {
            add,
            fail: async () => {
              await Bun.sleep(1);

              return ToolResult.failure("An expected failure");
            },
          },
        }).execute(
          `try {
          await tools.fail();
        } catch (error) {
          return { error: error.message, value: await tools.add({ a: 1, b: 2 }) };
        }`,
        )
      ).result,
    ).toEqual({ ok: true, value: { error: "An expected failure", value: 3 } });
  });

  test.each([
    ["Error", new Error("Private host diagnostics")],
    ["string", "Private string"],
    ["null", null],
  ] as const)("keeps an asynchronous host rejection with %s private", async (_name, error) => {
    const report = await new CodemodeSandbox({
      tools: {
        fail: async () => {
          await Bun.sleep(0);
          throw error;
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
    expect(
      (
        await new CodemodeSandbox({ tools: { read: () => ToolResult.success(value) } }).execute(
          "return await tools.read();",
        )
      ).result,
    ).toEqual({ ok: true, value });
  });

  test("starts concurrent calls before awaiting either result", async () => {
    const bothStarted = Promise.withResolvers<void>();
    let started = 0;
    expect(
      (
        await new CodemodeSandbox({
          tools: {
            echo: async (args) => {
              started += 1;
              if (started === 2) bothStarted.resolve();

              await bothStarted.promise;

              return ToolResult.success(args);
            },
          },
        }).execute("return await Promise.all([tools.echo(1), tools.echo(2)]);")
      ).result,
    ).toEqual({ ok: true, value: [1, 2] });
    expect(started).toBe(2);
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

      const completion = new CodemodeSandbox({
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
      expect((await completion).result).toEqual({ ok: true, value: scenario.value });
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

    const completion = new CodemodeSandbox({
      tools: {
        fast: () => ToolResult.success(1),
        slow: async () => {
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
    releaseLoser.resolve();
    expect((await completion).result).toEqual({ ok: true, value: 1 });
    expect(completed).toBe(true);
    expect(calls).toBe(1);
  });

  test("passes absent tool arguments as undefined", async () => {
    let argument: unknown = "not called";
    expect(
      (
        await new CodemodeSandbox({
          tools: {
            echo: (args) => {
              argument = args;

              return ToolResult.success(args);
            },
          },
        }).execute("return await tools.echo();")
      ).result,
    ).toEqual({
      ok: true,
      value: null,
    });
    expect(argument).toBeUndefined();
  });

  test("keeps JSON text distinct from the string value it encodes", async () => {
    const value = 'Hello "mcm"\n日本語';
    expect(
      (
        await new CodemodeSandbox({
          tools: {
            echo: (args) => ToolResult.success(args),
          },
        }).execute(`return await tools.echo(${JSON.stringify(value)});`)
      ).result,
    ).toEqual({ ok: true, value });
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

      const report = await new CodemodeSandbox({
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

  const cycle: { self?: unknown } = {};
  cycle.self = cycle;

  test.each([
    ["BigInt", 1n],
    ["function", () => 3],
    ["cycle", cycle],
  ] as const)(
    "rejects a non-JSON %s host result with a public conversion error",
    async (_name, value) => {
      const report = await new CodemodeSandbox({
        tools: {
          read: () => ToolResult.success(value),
        },
      }).execute("return await tools.read();");

      expect(report.result).toEqual({
        ok: false,
        error: { kind: "script", message: "Tool result is not JSON-serializable." },
      });
    },
  );

  test("reads an undefined tool result value once for guest delivery and retention", async () => {
    let reads = 0;

    const report = await new CodemodeSandbox({
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
    const report = await new CodemodeSandbox({
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
    const report = await new CodemodeSandbox({
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
    expect(
      (
        await new CodemodeSandbox({
          tools: {
            add,
          },
        }).execute("return [Object.keys(tools), typeof tools.toString, typeof tools.hidden];")
      ).result,
    ).toEqual({ ok: true, value: [["add"], "undefined", "undefined"] });

    const result = (
      await new CodemodeSandbox({ tools: { add } }).execute("return await tools.hidden();")
    ).result;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("script");
  });

  test("reports guest promises that cannot make progress", async () => {
    expect(
      (await new CodemodeSandbox().execute("return await new Promise(() => {});")).result,
    ).toEqual({
      ok: false,
      error: {
        kind: "script",
        message: "Script is waiting on a promise with no pending host calls.",
      },
    });
  });

  test("receives tool replies while guest jobs keep arriving", async () => {
    expect(
      (
        await new CodemodeSandbox({
          tools: {
            wait: async () => {
              await Bun.sleep(5);

              return ToolResult.success();
            },
          },
        }).execute(
          `let done = false;
         const call = tools.wait().then(() => { done = true; });
         while (!done) await Promise.resolve();
         await call;
         return done;`,
        )
      ).result,
    ).toEqual({ ok: true, value: true });
  });

  test("continues executing tools after a validation failure", async () => {
    const sandbox = new CodemodeSandbox({ tools: { add } });
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
