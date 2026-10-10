import { describe, expect, spyOn, test } from "bun:test";
import { Parser } from "acorn";
import { execute } from "../src/sandbox";
import { executeLocally } from "./local-tools";
import { rejectionOf } from "./rejection";

describe("sandbox", () => {
  test("executes a JavaScript function body", async () => {
    expect(await execute("return 1 + 2;")).toEqual({ ok: true, value: 3 });
  });

  test("returns JSON data", async () => {
    expect(await execute('return { name: "mcm", values: [1, true, null] };')).toEqual({
      ok: true,
      value: { name: "mcm", values: [1, true, null] },
    });
  });

  test("preserves falsy values", async () => {
    for (const value of [null, false, 0, ""]) {
      expect(await execute(`return ${JSON.stringify(value)};`)).toEqual({ ok: true, value });
    }
  });

  test("normalizes absent return values to null", async () => {
    expect(await execute("const value = 3;")).toEqual({ ok: true, value: null });
    expect(await execute("return undefined;")).toEqual({ ok: true, value: null });
  });

  test("uses native JSON conversion", async () => {
    expect(
      await execute("return { omitted: undefined, values: [undefined, NaN, Infinity] };"),
    ).toEqual({ ok: true, value: { values: [null, null, null] } });
  });

  test("keeps serialization working after JSON.stringify is replaced", async () => {
    expect(await execute('JSON.stringify = () => "broken"; return { value: 3 };')).toEqual({
      ok: true,
      value: { value: 3 },
    });
  });

  test("reports script errors", async () => {
    expect(await execute('throw new Error("Something failed");')).toEqual({
      ok: false,
      error: { kind: "script", message: "Something failed" },
    });
  });

  test("reports thrown strings and values without messages", async () => {
    expect(await execute('throw "Something failed";')).toEqual({
      ok: false,
      error: { kind: "script", message: "Something failed" },
    });
    expect(await execute("throw null;")).toEqual({
      ok: false,
      error: { kind: "script", message: "Script threw a value without an error message." },
    });
  });

  test("reports syntax errors", async () => {
    const result = await execute("return (; ");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("script");
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });

  test("reports thrown promises without consuming the caller's error handle", async () => {
    for (const code of [
      "throw Promise.resolve(3);",
      "throw new Promise(() => {});",
      'throw Promise.reject(new Error("inner"));',
      "throw Promise.reject(Promise.resolve(3));",
    ]) {
      expect(await execute(code)).toEqual({
        ok: false,
        error: { kind: "script", message: "Script threw a value without an error message." },
      });
    }
    expect(await execute("return 3;")).toEqual({ ok: true, value: 3 });
  });

  test("propagates unexpected parser failures instead of reporting a script error", async () => {
    const failure = new Error("Parser infrastructure failed");
    using parser = spyOn(Parser, "parse").mockImplementation(() => {
      throw failure;
    });
    expect((await rejectionOf(executeLocally("return 3;"))).reason).toBe(failure);
    expect(parser).toHaveBeenCalledTimes(1);
    parser.mockRestore();
    expect(await execute("return 3;")).toEqual({ ok: true, value: 3 });
  });

  test("awaits asynchronous return values", async () => {
    expect(await execute("return Promise.resolve(3);")).toEqual({
      ok: true,
      value: 3,
    });
  });

  test("awaits object and function thenables", async () => {
    for (const code of [
      "return { then(resolve) { resolve(3); } };",
      "const value = () => 3; value.then = resolve => resolve(3); return value;",
    ]) {
      expect(await execute(code)).toEqual({
        ok: true,
        value: 3,
      });
    }
  });

  test("allows ordinary values that are not thenables", async () => {
    const result = await execute("return { then: 3 };");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveProperty("then", 3);
    expect(await execute("Number.prototype.then = () => {}; return 3;")).toEqual({
      ok: true,
      value: 3,
    });
  });

  test("reports non-JSON return values", async () => {
    for (const code of ["return 1n;", "const value = {}; value.self = value; return value;"]) {
      const result = await execute(code);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("script");
    }
    expect(await execute("return () => 3;")).toEqual({
      ok: false,
      error: { kind: "script", message: "Return value is not JSON-serializable." },
    });
  });

  test("creates a fresh environment for each execution", async () => {
    expect(
      await execute("globalThis.marker = 3; Array.prototype.marker = 3; return marker;"),
    ).toEqual({
      ok: true,
      value: 3,
    });
    expect(await execute("return [typeof marker, typeof Array.prototype.marker];")).toEqual({
      ok: true,
      value: ["undefined", "undefined"],
    });
  });

  test("does not expose host APIs", async () => {
    expect(
      await execute("return [typeof process, typeof Bun, typeof require, typeof fetch];"),
    ).toEqual({ ok: true, value: ["undefined", "undefined", "undefined", "undefined"] });
  });

  test("releases resources after repeated successes and failures", async () => {
    for (let index = 0; index < 20; index += 1) {
      expect((await execute("return 3;")).ok).toBe(true);
      expect((await execute('throw new Error("failure");')).ok).toBe(false);
    }
    expect(await execute("return 3;")).toEqual({ ok: true, value: 3 });
  });

  test("interrupts infinite computation and permits the next execution", async () => {
    expect(await execute("while (true) {} ")).toEqual({
      ok: false,
      error: { kind: "timeout", message: "Execution exceeded the 1-second limit." },
    });
    expect(await execute("return 3;")).toEqual({ ok: true, value: 3 });
  });
});
