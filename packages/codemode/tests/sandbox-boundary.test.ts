import { describe, expect, test } from "bun:test";
import { CodeExecutor, ToolCatalog, ToolResult } from "@cmg/codemode";

describe("CodeExecutor guest boundary", () => {
  test("does not expose host APIs to guest code", async () => {
    const sandbox = new CodeExecutor();

    const report = await sandbox.execute(
      "return [typeof process, typeof Bun, typeof require, typeof fetch];",
    );

    expect(report.result).toEqual({
      ok: true,
      value: ["undefined", "undefined", "undefined", "undefined"],
    });
  });

  test("does not put raw callbacks or codec helpers in the user function's scope", async () => {
    const sandbox = new CodeExecutor({ tools: { answer: () => ToolResult.success(42) } });

    const report = await sandbox.execute(`return [
          typeof hostTools, typeof stringify, typeof parse, typeof decodeResult,
          typeof ConversionError, typeof AsyncFunction, typeof compile, typeof run,
          typeof dispatch, typeof pending, typeof settle, typeof nextCallId,
          eval("typeof dispatch"), Function("return typeof pending")(),
          typeof globalThis.run, typeof globalThis.settle,
        ];`);

    expect(report.result).toEqual({ ok: true, value: Array(16).fill("undefined") });
  });

  test("rejects access to raw callbacks without dispatching a host call", async () => {
    let calls = 0;

    const { result } = await new CodeExecutor({
      tools: {
        answer: () => {
          calls += 1;

          return ToolResult.success(42);
        },
      },
    }).execute("return await hostTools.answer();");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("script");

    expect(calls).toBe(0);
  });

  test("keeps private bindings hidden from eval and dynamic function constructors", async () => {
    const sandbox = new CodeExecutor();

    const report =
      await sandbox.execute(`const AsyncConstructor = Object.getPrototypeOf(async function() {}).constructor;
         return [
           eval("typeof hostTools"),
           (0, eval)("typeof hostTools"),
           Function("return typeof hostTools")(),
           await new AsyncConstructor("return typeof hostTools")()
         ];`);

    expect(report.result).toEqual({
      ok: true,
      value: ["undefined", "undefined", "undefined", "undefined"],
    });
  });

  test("lets eval and dynamic functions call the permitted public tools", async () => {
    const sandbox = new CodeExecutor({ tools: { answer: () => ToolResult.success(42) } });

    const report = await sandbox.execute(`return [
          await eval("tools.answer()"),
          await (0, eval)("tools.answer()"),
          await Function("return tools.answer()")()
        ];`);

    expect(report.result).toEqual({ ok: true, value: [42, 42, 42] });
  });

  test.each([
    ["statements", "}); tools.write(); (async (tools) => { return 3;"],
    ["comma expressions", "}), tools.write(), (async (tools) => { return 3;"],
    ["a global assignment", "}); globalThis.escaped = true; (async () => {"],
  ] as const)(
    "rejects function-wrapper escape through %s before executing any user code and recovers",
    async (_name, code) => {
      let calls = 0;

      const sandbox = new CodeExecutor({
        tools: {
          write: () => {
            calls += 1;

            return ToolResult.success();
          },
        },
      });

      const rejected = await sandbox.execute(code);
      const recovered = await sandbox.execute("return 3;");

      expect(rejected).toEqual({
        result: {
          ok: false,
          error: {
            kind: "script",
            message: "Source must stay inside the submitted async function body.",
          },
        },
        calls: [],
      });
      expect(calls).toBe(0);
      expect(recovered.result).toEqual({ ok: true, value: 3 });
    },
  );

  test("accepts classes, generators, and wrapper-like text in strings, regexes, and comments", async () => {
    const sandbox = new CodeExecutor();

    const report = await sandbox.execute(`
        const text = "}); tools.write(); (async () => {";
        const braces = /[{}]/g;
        /* } }) ; */
        class Counter {
          #value = 1;
          next() { return this.#value++; }
        }
        function* values() {
          yield new Counter().next();
          yield [..."{}"].length;
        }
        return { text, matches: "{}".match(braces), total: [...values()].reduce((a, b) => a + b, 0) };
      `);

    expect(report.result).toEqual({
      ok: true,
      value: { text: "}); tools.write(); (async () => {", matches: ["{", "}"], total: 3 },
    });
  });

  test("keeps normal function-local closures independent of the private prelude", async () => {
    const sandbox = new CodeExecutor({ tools: { answer: () => ToolResult.success(42) } });

    const report = await sandbox.execute(`const hostTools = { answer: () => 1 };
         const stringify = () => "local";
         const local = () => [hostTools.answer(), stringify()];
         return { local: local(), public: await tools.answer() };`);

    expect(report.result).toEqual({ ok: true, value: { local: [1, "local"], public: 42 } });
  });

  test("does not let user globals replace private prelude helpers", async () => {
    const sandbox = new CodeExecutor({ tools: { answer: () => ToolResult.success(42) } });

    const report = await sandbox.execute(`globalThis.hostTools = { answer: () => 0 };
         globalThis.stringify = () => "broken";
         globalThis.parse = () => "broken";
         globalThis.decodeResult = () => "broken";
         globalThis.run = () => "broken";
         return await tools.answer();`);

    expect(report.result).toEqual({ ok: true, value: 42 });
  });

  test("binds guest this and public tools to globalThis", async () => {
    const sandbox = new CodeExecutor();

    const report = await sandbox.execute(
      "return [this === globalThis, tools === globalThis.tools];",
    );

    expect(report.result).toEqual({
      ok: true,
      value: [true, true],
    });
  });

  test("rejects assignments to public tools before dispatch", async () => {
    let calls = 0;

    const { result } = await new CodeExecutor({
      tools: {
        answer: () => {
          calls += 1;

          return ToolResult.success(42);
        },
      },
    }).execute("tools.answer = () => 0; return await tools.answer();");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("script");

    expect(calls).toBe(0);
  });

  test("keeps codecs working after global JSON, Promise, and TypeError are replaced", async () => {
    const sandbox = new CodeExecutor({ tools: { echo: (args) => ToolResult.success(args) } });

    const report = await sandbox.execute(`JSON.stringify = () => "broken";
         JSON.parse = () => "broken";
         Promise.prototype.then = () => { throw new Error("Modified then"); };
          globalThis.Promise = function() { throw new Error("Modified Promise"); };
          globalThis.TypeError = function() { throw new Error("Modified TypeError"); };
          let message;
          try { tools.echo(() => 3); } catch (error) { message = error.message; }
           return { message, value: await tools.echo({ value: 3 }) };`);

    expect(report.result).toEqual({
      ok: true,
      value: {
        message: "Tool arguments are not JSON-serializable.",
        value: { value: 3 },
      },
    });
  });

  test("releases the call slot before decoded-result then getters start another call", async () => {
    const sandbox = new CodeExecutor({
      tools: {
        read: () => ToolResult.success({ marker: true }),
        follow: () => ToolResult.success(),
      },
      maxConcurrentToolCalls: 1,
    });

    const report = await sandbox.execute(`
      Object.defineProperty(Object.prototype, "then", {
        get() { if (this.marker === true) tools.follow(); return undefined; }
      });
      return (await tools.read()).marker;
    `);

    expect(report.result).toEqual({ ok: true, value: true });
    expect(report.calls.map((call) => call.name)).toEqual(["read", "follow"]);
  });

  test("keeps private promise bookkeeping intact when guest built-ins are replaced", async () => {
    const sandbox = new CodeExecutor({
      tools: {
        read: (args) => ToolResult.success(args),
        fail: () => ToolResult.failure("Public failure"),
      },
    });

    const report = await sandbox.execute(`
      const Broken = () => { throw new Error("replaced"); };
      Map.prototype.get = Map.prototype.set = Map.prototype.delete = Broken;
      Promise.prototype.then = Broken;
      Reflect.apply = Object.create = Promise = Error = Broken;
      await tools.read(42);
      try { await tools.fail(); } catch (error) { return error.message; }
    `);

    expect(report.result).toEqual({ ok: true, value: "Public failure" });
    expect(report.calls.map((call) => call.name)).toEqual(["read", "fail"]);
  });

  test("does not let inherited toJSON rewrite private call envelopes", async () => {
    const received: unknown[] = [];

    const sandbox = new CodeExecutor({
      tools: {
        read: (args) => {
          received.push(args);

          return ToolResult.success(42);
        },
      },
    });

    const report = await sandbox.execute(`
      Object.prototype.toJSON = function () { return "guest-converted"; };
      await tools.read({ id: 1 });
      return await tools.read();
    `);

    expect(report.result).toEqual({ ok: true, value: 42 });
    expect(received).toEqual(["guest-converted", undefined]);
    expect(report.calls.map((call) => call.callId)).toEqual([1, 2]);
  });

  test("preserves exact catalog names across guest dispatch without prototype or string collisions", async () => {
    const names = [
      "billing.list-invoices",
      "__proto__",
      "constructor",
      "toString",
      "a",
      "a\u0000b",
      "a\ud800",
      "a\ufffd",
      "",
    ];

    const catalog = ToolCatalog.create(
      Object.fromEntries(
        names.map((name) => [
          name,
          {
            description: name,
            execute: () => ToolResult.success(name),
          },
        ]),
      ),
    );

    const sandbox = new CodeExecutor({ tools: catalog.tools });

    const report = await sandbox.execute(
      `return await Promise.all(${JSON.stringify(names)}.map(name => tools[name]()));`,
    );

    expect(report.result).toEqual({ ok: true, value: names });
    expect(report.calls.map((call) => call.name)).toEqual(names);
  });

  test("delivers complete public failure text despite guest-global mutations", async () => {
    const message = "before\u0000after\ud800";
    const sandbox = new CodeExecutor({ tools: { fail: () => ToolResult.failure(message) } });

    const report = await sandbox.execute(`
      JSON.parse = JSON.stringify = () => "replaced";
      try { await tools.fail(); } catch (error) { error.message += "!"; return error.message; }
    `);

    expect(report.result).toEqual({ ok: true, value: message + "!" });
    expect(report.calls).toEqual([
      { callId: 1, name: "fail", status: "completed", result: { ok: false, error: { message } } },
    ]);
  });
});
