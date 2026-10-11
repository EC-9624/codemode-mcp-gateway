import { describe, expect, test } from "bun:test";
import { execute, ToolResult } from "../../src/sandbox";

describe("guest prelude boundary", () => {
  test("does not put raw callbacks or codec helpers in the user function's scope", async () => {
    expect(
      (
        await execute(
          `return [
          typeof hostTools, typeof stringify, typeof parse, typeof decodeResult,
          typeof ConversionError, typeof AsyncFunction, typeof compile, typeof run
        ];`,
          { answer: () => ToolResult.success(42) },
        )
      ).result,
    ).toEqual({ ok: true, value: Array.from({ length: 8 }, () => "undefined") });
  });

  test("rejects access to raw callbacks without dispatching a host call", async () => {
    let calls = 0;

    const { result } = await execute("return await hostTools.answer();", {
      answer: () => {
        calls += 1;

        return ToolResult.success(42);
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("script");

    expect(calls).toBe(0);
  });

  test("keeps private bindings hidden from eval and dynamic function constructors", async () => {
    expect(
      (
        await execute(
          `const AsyncConstructor = Object.getPrototypeOf(async function() {}).constructor;
         return [
           eval("typeof hostTools"),
           (0, eval)("typeof hostTools"),
           Function("return typeof hostTools")(),
           await new AsyncConstructor("return typeof hostTools")()
         ];`,
        )
      ).result,
    ).toEqual({ ok: true, value: Array.from({ length: 4 }, () => "undefined") });
  });

  test("lets eval and dynamic functions call the permitted public tools", async () => {
    expect(
      (
        await execute(
          `return [
          await eval("tools.answer()"),
          await (0, eval)("tools.answer()"),
          await Function("return tools.answer()")()
        ];`,
          { answer: () => ToolResult.success(42) },
        )
      ).result,
    ).toEqual({ ok: true, value: [42, 42, 42] });
  });

  test("rejects function-wrapper escape syntax before executing any user code", async () => {
    let calls = 0;

    const write = () => {
      calls += 1;

      return ToolResult.success();
    };

    for (const code of [
      "}); tools.write(); (async (tools) => { return 3;",
      "}), tools.write(), (async (tools) => { return 3;",
    ]) {
      const { result } = await execute(code, { write });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("script");

      expect(calls).toBe(0);
    }

    expect((await execute("return 3;")).result).toEqual({ ok: true, value: 3 });
  });

  test("accepts classes, generators, and wrapper-like text in strings, regexes, and comments", async () => {
    expect(
      (
        await execute(`
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
      `)
      ).result,
    ).toEqual({
      ok: true,
      value: { text: "}); tools.write(); (async () => {", matches: ["{", "}"], total: 3 },
    });
  });

  test("keeps normal function-local closures independent of the private prelude", async () => {
    expect(
      (
        await execute(
          `const hostTools = { answer: () => 1 };
         const stringify = () => "local";
         const local = () => [hostTools.answer(), stringify()];
         return { local: local(), public: await tools.answer() };`,
          { answer: () => ToolResult.success(42) },
        )
      ).result,
    ).toEqual({ ok: true, value: { local: [1, "local"], public: 42 } });
  });

  test("does not let user globals replace private prelude helpers", async () => {
    expect(
      (
        await execute(
          `globalThis.hostTools = { answer: () => 0 };
         globalThis.stringify = () => "broken";
         globalThis.parse = () => "broken";
         globalThis.decodeResult = () => "broken";
         globalThis.run = () => "broken";
         return await tools.answer();`,
          { answer: () => ToolResult.success(42) },
        )
      ).result,
    ).toEqual({ ok: true, value: 42 });
  });

  test("binds guest this to globalThis", async () => {
    expect((await execute("return this === globalThis;")).result).toEqual({
      ok: true,
      value: true,
    });
  });

  test("rejects assignments to public tools before dispatch", async () => {
    let calls = 0;

    const { result } = await execute("tools.answer = () => 0; return await tools.answer();", {
      answer: () => {
        calls += 1;

        return ToolResult.success(42);
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("script");

    expect(calls).toBe(0);
  });

  test("keeps codecs working after global JSON, Promise, and TypeError are replaced", async () => {
    expect(
      (
        await execute(
          `JSON.stringify = () => "broken";
         JSON.parse = () => "broken";
         Promise.prototype.then = () => { throw new Error("Modified then"); };
         globalThis.Promise = function() { throw new Error("Modified Promise"); };
         globalThis.TypeError = function() { throw new Error("Modified TypeError"); };
         return await tools.echo({ value: 3 });`,
          { echo: (args) => ToolResult.success(args) },
        )
      ).result,
    ).toEqual({ ok: true, value: { value: 3 } });
  });
});
