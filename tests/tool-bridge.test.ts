import { describe, expect, spyOn, test } from "bun:test";
import { QuickJSContext, Scope } from "quickjs-emscripten";
import { createVm } from "../src/runtime";
import { execute, ToolResult, type SandboxTool } from "../src/sandbox";
import { installTools } from "../src/tool-bridge";
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

  test("validates inputs in the host before performing domain work", async () => {
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

  test("drains unawaited calls before reporting success", async () => {
    let completed = false;
    expect(
      await execute('tools.write(); return "done";', {
        write: async () => {
          await Bun.sleep(5);
          completed = true;
          return ToolResult.success();
        },
      }),
    ).toEqual({ ok: true, value: "done" });
    expect(completed).toBe(true);
  });

  test("drains race losers without replay or automatic cancellation", async () => {
    let completed = false;
    expect(
      await execute("return await Promise.race([tools.fast(), tools.slow()]);", {
        fast: () => ToolResult.success(1),
        slow: async () => {
          await Bun.sleep(5);
          completed = true;
          return ToolResult.success(2);
        },
      }),
    ).toEqual({ ok: true, value: 1 });
    expect(completed).toBe(true);
  });

  test("round-trips JSON without sharing host object identity", async () => {
    const source = { nested: { value: 3 } };
    expect(
      await execute("const value = await tools.read(); value.nested.value = 4; return value;", {
        read: () => ToolResult.success(source),
      }),
    ).toEqual({ ok: true, value: { nested: { value: 4 } } });
    expect(source.nested.value).toBe(3);
    expect(
      await execute("return await tools.echo();", { echo: (args) => ToolResult.success(args) }),
    ).toEqual({
      ok: true,
      value: null,
    });
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
    const bridge = installTools(
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
      const bridge = installTools(vm, { answer: () => ToolResult.success(42) }, scope);
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
    const bridge = installTools(vm, { fail: () => ToolResult.failure("Public failure") }, scope);
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

    expect(
      (
        await rejectionOf(
          execute("tools.answer(); while (true) await Promise.resolve();", {
            answer: () => {
              // Inject only after VM setup, so the failure exercises bridge settlement.
              const fault = spyOn(QuickJSContext.prototype, "newString").mockImplementation(() => {
                throw failure;
              });
              cleanup.defer(() => fault.mockRestore());
              return ToolResult.success(42);
            },
          }),
        )
      ).reason,
    ).toBe(failure);
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

  test("rejects non-JSON host results with corrective public errors", async () => {
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

  test("drains calls started by result serialization", async () => {
    let completed = false;
    expect(
      await execute("return { toJSON() { tools.write(); return 3; } };", {
        write: async () => {
          await Bun.sleep(5);
          completed = true;
          return ToolResult.success();
        },
      }),
    ).toEqual({ ok: true, value: 3 });
    expect(completed).toBe(true);
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

  test("yields to host timers while guest jobs keep arriving", async () => {
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

  test("does not touch a closed VM when host calls settle after timeout", async () => {
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

  test("closes the bridge on script failure without waiting for unrelated calls", async () => {
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

  test("releases bridge handles after repeated success and failure", async () => {
    for (let index = 0; index < 10; index += 1) {
      expect((await execute("return await tools.add({ a: 1, b: 2 });", { add })).ok).toBe(true);
      expect((await execute("return await tools.add(null);", { add })).ok).toBe(false);
    }
  });
});
