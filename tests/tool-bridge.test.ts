import { describe, expect, spyOn, test } from "bun:test";
import { type QuickJSContext, Scope } from "quickjs-emscripten";
import { createVm } from "../src/runtime";
import { execute, ToolResult, type SandboxTool } from "../src/sandbox";
import { executeEngine } from "../src/sandbox-engine";
import { installLocalTools } from "./local-tools";
import { rejectionOf } from "./rejection";

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

describe("async tool bridge", () => {
  test("awaits a real asynchronous host operation", async () => {
    expect(await execute("return await tools.add({ a: 1, b: 2 });", { add })).toEqual({
      ok: true,
      value: 3,
    });
  });

  test("also bridges synchronous host callbacks", async () => {
    expect(
      await execute("return await tools.answer();", { answer: () => ToolResult.success(42) }),
    ).toEqual({
      ok: true,
      value: 42,
    });
  });

  test("reports uncaught tool argument validation failures as script errors", async () => {
    expect(await execute('return await tools.add({ a: "wrong", b: 2 });', { add })).toEqual({
      ok: false,
      error: { kind: "script", message: "add expects numeric a and b." },
    });
  });

  test("lets the script catch public host errors and continue", async () => {
    expect(
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
      ),
    ).toEqual({ ok: true, value: { error: "An expected failure", value: 3 } });
  });

  test("does not expose private host error messages or stacks", async () => {
    expect(
      await execute("return await tools.fail();", {
        fail: () => {
          throw new Error("Private host diagnostics");
        },
      }),
    ).toEqual({ ok: false, error: { kind: "script", message: "Host tool failed." } });
  });

  test("keeps arbitrary asynchronous host rejections private", async () => {
    for (const error of [new Error("Private host diagnostics"), "Private string", null]) {
      expect(
        await execute("return await tools.fail();", {
          fail: async () => {
            await Bun.sleep(0);
            throw error;
          },
        }),
      ).toEqual({ ok: false, error: { kind: "script", message: "Host tool failed." } });
    }
  });

  test("does not interpret failure-shaped tool data as a bridge failure", async () => {
    const value = { ok: false, error: { message: "Ordinary data" } };
    expect(
      await execute("return await tools.read();", { read: () => ToolResult.success(value) }),
    ).toEqual({ ok: true, value });
  });

  test("dispatches once when the same promise is awaited twice", async () => {
    let calls = 0;
    expect(
      await execute("const call = tools.answer(); return [await call, await call];", {
        answer: () => {
          calls += 1;
          return ToolResult.success(3);
        },
      }),
    ).toEqual({ ok: true, value: [3, 3] });
    expect(calls).toBe(1);
  });

  test("starts concurrent calls before awaiting either result", async () => {
    const bothStarted = Promise.withResolvers<void>();
    let started = 0;
    expect(
      await execute("return await Promise.all([tools.echo(1), tools.echo(2)]);", {
        echo: async (args) => {
          started += 1;
          if (started === 2) bothStarted.resolve();
          await bothStarted.promise;
          return ToolResult.success(args);
        },
      }),
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
      expect(await completion).toEqual({ ok: true, value: scenario.value });
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
    expect(await completion).toEqual({ ok: true, value: 1 });
    expect(completed).toBe(true);
    expect(calls).toBe(1);
  });

  test("round-trips JSON without sharing host object identity", async () => {
    const source = { nested: { value: 3 } };
    expect(
      await execute("const value = await tools.read(); value.nested.value = 4; return value;", {
        read: () => ToolResult.success(source),
      }),
    ).toEqual({ ok: true, value: { nested: { value: 4 } } });
    expect(source.nested.value).toBe(3);
  });

  test("passes absent tool arguments as undefined", async () => {
    let argument: unknown = "not called";
    expect(
      await execute("return await tools.echo();", {
        echo: (args) => {
          argument = args;
          return ToolResult.success(args);
        },
      }),
    ).toEqual({
      ok: true,
      value: null,
    });
    expect(argument).toBeUndefined();
  });

  test("preserves argument and result conversion after guest JSON mutation", async () => {
    expect(
      await execute(
        `JSON.stringify = () => "broken";
         JSON.parse = () => "broken";
         return await tools.add({ a: 1, b: 2 });`,
        { add },
      ),
    ).toEqual({ ok: true, value: 3 });
  });

  test("keeps global tools usable and does not depend on guest Promise.then", async () => {
    expect(
      await execute(
        `Promise.prototype.then = () => { throw new Error("Modified then"); };
         return await globalThis.tools.add({ a: 1, b: 2 });`,
        { add },
      ),
    ).toEqual({ ok: true, value: 3 });
  });

  test("keeps JSON text distinct from the string value it encodes", async () => {
    const value = 'Hello "mcm"\n日本語';
    expect(
      await execute(`return await tools.echo(${JSON.stringify(value)});`, {
        echo: (args) => ToolResult.success(args),
      }),
    ).toEqual({ ok: true, value });
  });

  test("rejects malformed low-level bridge payloads before host dispatch", async () => {
    using vm = await createVm();
    using scope = new Scope();
    let calls = 0;
    const bridge = installLocalTools(
      vm,
      {
        echo: (args) => {
          calls += 1;
          return ToolResult.success(args);
        },
      },
      scope,
    );

    for (const code of ['tools.echo("not JSON");', "tools.echo({});"]) {
      using result = vm.evalCode(code);
      expect(result.error).toBeDefined();
    }
    expect(calls).toBe(0);
    expect(bridge.pendingCalls.size).toBe(0);
  });

  test("propagates VM failures without retrying settlement as a tool rejection", async () => {
    for (const method of ["newString", "callFunction"] as const) {
      using vm = await createVm();
      using scope = new Scope();
      const bridge = installLocalTools(vm, { answer: () => ToolResult.success(42) }, scope);
      const failure = new Error("VM infrastructure failed");
      using fault = spyOn(vm, method).mockImplementation(() => {
        throw failure;
      });
      using guestErrors = spyOn(vm, "newError");

      using result = vm.evalCode("tools.answer();");
      expect(result.error).toBeUndefined();
      expect((await rejectionOf(Promise.all(bridge.pendingCalls))).reason).toBe(failure);
      expect(fault).toHaveBeenCalledTimes(1);
      expect(guestErrors).not.toHaveBeenCalled();
    }
  });

  test("propagates VM failures while rejecting an explicit tool failure", async () => {
    using vm = await createVm();
    using scope = new Scope();
    const bridge = installLocalTools(
      vm,
      { fail: () => ToolResult.failure("Public failure") },
      scope,
    );
    const failure = new Error("VM infrastructure failed");
    using fault = spyOn(vm, "newError").mockImplementation(() => {
      throw failure;
    });

    using result = vm.evalCode("tools.fail();");
    expect(result.error).toBeUndefined();
    expect((await rejectionOf(Promise.all(bridge.pendingCalls))).reason).toBe(failure);
    expect(fault).toHaveBeenCalledTimes(1);
  });

  test("propagates infrastructure failures even while guest jobs keep arriving", async () => {
    const failure = new Error("VM allocation failed");
    using cleanup = new DisposableStack();
    const resources: { vm: QuickJSContext; scope: Scope }[] = [];
    const completion = executeEngine(
      "tools.answer(); while (true) await Promise.resolve();",
      (vm, scope) => {
        resources.push({ vm, scope });
        return installLocalTools(
          vm,
          {
            answer: () => {
              // Injecting during setup would not exercise bridge settlement while guest jobs arrive.
              const fault = spyOn(vm, "newString").mockImplementation(() => {
                throw failure;
              });
              cleanup.defer(() => fault.mockRestore());
              return ToolResult.success(42);
            },
          },
          scope,
        );
      },
    );
    expect((await rejectionOf(completion)).reason).toBe(failure);
    expect(resources).toHaveLength(1);
    for (const { vm, scope } of resources) {
      expect(vm.alive).toBe(false);
      expect(vm.runtime.alive).toBe(false);
      expect(scope.alive).toBe(false);
    }
    cleanup.dispose();
    expect(await execute("return 3;")).toEqual({ ok: true, value: 3 });
  });

  test("rejects non-JSON arguments before host dispatch", async () => {
    let calls = 0;
    const echo: SandboxTool = (args) => {
      calls += 1;
      return ToolResult.success(args);
    };
    for (const code of [
      "return await tools.echo(1n);",
      "return await tools.echo(() => 3);",
      "const value = {}; value.self = value; return await tools.echo(value);",
    ]) {
      const result = await execute(code, { echo });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("script");
    }
    expect(calls).toBe(0);
  });

  test("rejects non-JSON host results with a public conversion error", async () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    for (const value of [1n, () => 3, cycle]) {
      expect(
        await execute("return await tools.read();", { read: () => ToolResult.success(value) }),
      ).toEqual({
        ok: false,
        error: { kind: "script", message: "Tool result is not JSON-serializable." },
      });
    }
  });

  test("treats throwing host getters and toJSON hooks as conversion failures", async () => {
    for (const value of [
      {
        get secret() {
          throw new Error("Private getter diagnostics");
        },
      },
      {
        toJSON() {
          throw "Private conversion diagnostics";
        },
      },
    ]) {
      expect(
        await execute("return await tools.read();", { read: () => ToolResult.success(value) }),
      ).toEqual({
        ok: false,
        error: { kind: "script", message: "Tool result is not JSON-serializable." },
      });
    }
  });

  test("only exposes supplied tools and no inherited host functions", async () => {
    expect(
      await execute("return [Object.keys(tools), typeof tools.toString, typeof tools.hidden];", {
        add,
      }),
    ).toEqual({ ok: true, value: [["add"], "undefined", "undefined"] });
    const result = await execute("return await tools.hidden();", { add });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("script");
  });

  test("reports guest promises that cannot make progress", async () => {
    expect(await execute("return await new Promise(() => {});")).toEqual({
      ok: false,
      error: {
        kind: "script",
        message: "Script is waiting on a promise with no pending host calls.",
      },
    });
  });

  test("times out an infinite guest microtask chain and recovers", async () => {
    expect(await execute("while (true) await Promise.resolve();")).toEqual({
      ok: false,
      error: { kind: "timeout", message: "Execution exceeded the 1-second limit." },
    });
    expect(await execute("return await tools.add({ a: 1, b: 2 });", { add })).toEqual({
      ok: true,
      value: 3,
    });
  });

  test("receives tool replies while guest jobs keep arriving", async () => {
    expect(
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
      ),
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
    expect(results).toEqual(Array.from({ length: 10 }, (_, value) => ({ ok: true, value })));
  });

  test("includes unawaited host calls in the deadline", async () => {
    const late = Promise.withResolvers<number>();
    expect(
      await execute("tools.wait(); return 3;", {
        wait: async () => ToolResult.success(await late.promise),
      }),
    ).toEqual({
      ok: false,
      error: { kind: "timeout", message: "Execution exceeded the 1-second limit." },
    });
    late.resolve(3);
    await Bun.sleep(0);
  });

  test("allows new executions after timed-out callbacks fulfill or reject late", async () => {
    for (const fail of [false, true]) {
      const late = Promise.withResolvers<number>();
      expect(
        await execute("return await tools.wait();", {
          wait: async () => ToolResult.success(await late.promise),
        }),
      ).toEqual({
        ok: false,
        error: { kind: "timeout", message: "Execution exceeded the 1-second limit." },
      });
      if (fail) late.reject(new Error("Late private failure"));
      else late.resolve(3);
      await Bun.sleep(0);
      expect(await execute("return await tools.add({ a: 1, b: 2 });", { add })).toEqual({
        ok: true,
        value: 3,
      });
    }
  });

  test("reports script failure without waiting for unrelated callbacks", async () => {
    const late = Promise.withResolvers<number>();
    expect(
      await execute('tools.wait(); throw new Error("Script failed");', {
        wait: async () => ToolResult.success(await late.promise),
      }),
    ).toEqual({ ok: false, error: { kind: "script", message: "Script failed" } });
    late.resolve(3);
    await Bun.sleep(0);
    expect(await execute("return 3;")).toEqual({ ok: true, value: 3 });
  });

  test("continues executing tools after repeated success and validation failure", async () => {
    for (let index = 0; index < 10; index += 1) {
      expect((await execute("return await tools.add({ a: 1, b: 2 });", { add })).ok).toBe(true);
      expect((await execute("return await tools.add(null);", { add })).ok).toBe(false);
    }
  });
});
