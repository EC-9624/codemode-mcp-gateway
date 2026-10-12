import { describe, expect, test } from "bun:test";
import { execute, ToolResult, type SandboxTool } from "../../src/codemode";

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
    expect((await execute("return await tools.add({ a: 1, b: 2 });", { add })).result).toEqual({
      ok: true,
      value: 3,
    });
  });

  test("also bridges synchronous host callbacks", async () => {
    expect(
      (await execute("return await tools.answer();", { answer: () => ToolResult.success(42) }))
        .result,
    ).toEqual({
      ok: true,
      value: 42,
    });
  });

  test("reports uncaught tool argument validation failures as script errors", async () => {
    expect(
      (await execute('return await tools.add({ a: "wrong", b: 2 });', { add })).result,
    ).toEqual({
      ok: false,
      error: { kind: "script", message: "add expects numeric a and b." },
    });
  });

  test("lets the script catch public host errors and continue", async () => {
    expect(
      (
        await execute(
          `try {
          await tools.fail();
        } catch (error) {
          return { error: error.message, value: await tools.add({ a: 1, b: 2 }) };
        }`,
          {
            add,
            fail: async () => {
              await Bun.sleep(1);

              return ToolResult.failure("An expected failure");
            },
          },
        )
      ).result,
    ).toEqual({ ok: true, value: { error: "An expected failure", value: 3 } });
  });

  test("does not expose private host error messages or stacks", async () => {
    expect(
      (
        await execute("return await tools.fail();", {
          fail: () => {
            throw new Error("Private host diagnostics");
          },
        })
      ).result,
    ).toEqual({ ok: false, error: { kind: "script", message: "Host tool failed." } });
  });

  test.each([
    ["Error", new Error("Private host diagnostics")],
    ["string", "Private string"],
    ["null", null],
  ] as const)("keeps an asynchronous host rejection with %s private", async (_name, error) => {
    const report = await execute("return await tools.fail();", {
      fail: async () => {
        await Bun.sleep(0);
        throw error;
      },
    });

    expect(report.result).toEqual({
      ok: false,
      error: { kind: "script", message: "Host tool failed." },
    });
  });

  test("does not interpret failure-shaped tool data as a bridge failure", async () => {
    const value = { ok: false, error: { message: "Ordinary data" } };
    expect(
      (await execute("return await tools.read();", { read: () => ToolResult.success(value) }))
        .result,
    ).toEqual({ ok: true, value });
  });

  test("starts concurrent calls before awaiting either result", async () => {
    const bothStarted = Promise.withResolvers<void>();
    let started = 0;
    expect(
      (
        await execute("return await Promise.all([tools.echo(1), tools.echo(2)]);", {
          echo: async (args) => {
            started += 1;
            if (started === 2) bothStarted.resolve();

            await bothStarted.promise;

            return ToolResult.success(args);
          },
        })
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

      const completion = execute(scenario.code, {
        write: async () => {
          started.resolve();
          await release.promise;
          completed = true;

          return ToolResult.success();
        },
      }).then((result) => {
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

    const completion = execute(
      `
        const winner = await Promise.race([tools.fast(), tools.slow()]);
        await tools.reportWinner(winner);
        return winner;
      `,
      {
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
    ).then((result) => {
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

  test("round-trips JSON without sharing host object identity", async () => {
    const source = { nested: { value: 3 } };
    expect(
      (
        await execute("const value = await tools.read(); value.nested.value = 4; return value;", {
          read: () => ToolResult.success(source),
        })
      ).result,
    ).toEqual({ ok: true, value: { nested: { value: 4 } } });
    expect(source.nested.value).toBe(3);
  });

  test("passes absent tool arguments as undefined", async () => {
    let argument: unknown = "not called";
    expect(
      (
        await execute("return await tools.echo();", {
          echo: (args) => {
            argument = args;

            return ToolResult.success(args);
          },
        })
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
        await execute(`return await tools.echo(${JSON.stringify(value)});`, {
          echo: (args) => ToolResult.success(args),
        })
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

      const report = await execute(code, {
        echo: (args) => {
          calls += 1;

          return ToolResult.success(args);
        },
      });

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
      const report = await execute("return await tools.read();", {
        read: () => ToolResult.success(value),
      });

      expect(report.result).toEqual({
        ok: false,
        error: { kind: "script", message: "Tool result is not JSON-serializable." },
      });
    },
  );

  test("reads an undefined tool result value once for guest delivery and retention", async () => {
    let reads = 0;

    const report = await execute("return (await tools.read()) === undefined;", {
      read: () => ({
        ok: true,
        get value() {
          reads++;
          if (reads > 1) throw new Error("Private repeated getter failure");

          return undefined;
        },
      }),
    });

    expect(report).toEqual({
      result: { ok: true, value: true },
      calls: [
        { callId: 1, name: "read", status: "completed", result: { ok: true, json: undefined } },
      ],
    });
    expect(reads).toBe(1);
  });

  test("lets the guest catch a private tool result value getter failure as a conversion error", async () => {
    const report = await execute(
      "try { await tools.read(); } catch (error) { return error.message; }",
      {
        read: () => ({
          ok: true,
          get value() {
            throw new Error("Private value getter failure");
          },
        }),
      },
    );

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
    const report = await execute("return await tools.read();", {
      read: () => ToolResult.success(value),
    });

    expect(report.result).toEqual({
      ok: false,
      error: { kind: "script", message: "Tool result is not JSON-serializable." },
    });
  });

  test("only exposes supplied tools and no inherited host functions", async () => {
    expect(
      (
        await execute("return [Object.keys(tools), typeof tools.toString, typeof tools.hidden];", {
          add,
        })
      ).result,
    ).toEqual({ ok: true, value: [["add"], "undefined", "undefined"] });
    const result = (await execute("return await tools.hidden();", { add })).result;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("script");
  });

  test("reports guest promises that cannot make progress", async () => {
    expect((await execute("return await new Promise(() => {});")).result).toEqual({
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
        await execute(
          `let done = false;
         const call = tools.wait().then(() => { done = true; });
         while (!done) await Promise.resolve();
         await call;
         return done;`,
          {
            wait: async () => {
              await Bun.sleep(5);

              return ToolResult.success();
            },
          },
        )
      ).result,
    ).toEqual({ ok: true, value: true });
  });

  test("keeps concurrently running execution bridges separate", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, value) =>
        execute("return await tools.read();", {
          read: async () => {
            await Bun.sleep(1);

            return ToolResult.success(value);
          },
        }),
      ),
    );

    expect(results.map((report) => report.result)).toEqual(
      Array.from({ length: 10 }, (_, value) => ({ ok: true, value })),
    );
  });

  test("continues executing tools after a validation failure", async () => {
    const succeeded = await execute("return await tools.add({ a: 1, b: 2 });", { add });
    const failed = await execute("return await tools.add(null);", { add });
    const recovered = await execute("return await tools.add({ a: 1, b: 2 });", { add });

    expect(succeeded.result).toEqual({ ok: true, value: 3 });
    expect(failed.result).toEqual({
      ok: false,
      error: { kind: "script", message: "add expects numeric a and b." },
    });
    expect(recovered.result).toEqual({ ok: true, value: 3 });
  });
});
