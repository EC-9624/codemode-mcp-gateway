import { describe, expect, test } from "bun:test";
import { CodemodeSandbox } from "@cmg/codemode";

const sandbox = new CodemodeSandbox();

describe("sandbox", () => {
  test("executes a JavaScript function body", async () => {
    expect(await sandbox.execute("return 1 + 2;")).toEqual({
      result: { ok: true, value: 3 },
      calls: [],
    });
  });

  test("returns JSON data", async () => {
    expect(
      (await sandbox.execute('return { name: "mcm", values: [1, true, null] };')).result,
    ).toEqual({
      ok: true,
      value: { name: "mcm", values: [1, true, null] },
    });
  });

  test.each([
    ["null", null],
    ["false", false],
    ["zero", 0],
    ["an empty string", ""],
  ] as const)("preserves %s as a falsy return value", async (_name, value) => {
    expect((await sandbox.execute(`return ${JSON.stringify(value)};`)).result).toEqual({
      ok: true,
      value,
    });
  });

  test("normalizes absent return values to null", async () => {
    expect((await sandbox.execute("const value = 3;")).result).toEqual({ ok: true, value: null });
    expect((await sandbox.execute("return undefined;")).result).toEqual({ ok: true, value: null });
  });

  test("uses native JSON conversion", async () => {
    expect(
      (await sandbox.execute("return { omitted: undefined, values: [undefined, NaN, Infinity] };"))
        .result,
    ).toEqual({ ok: true, value: { values: [null, null, null] } });
  });

  test("keeps serialization working after JSON.stringify is replaced", async () => {
    expect(
      (await sandbox.execute('JSON.stringify = () => "broken"; return { value: 3 };')).result,
    ).toEqual({
      ok: true,
      value: { value: 3 },
    });
  });

  test("reports script errors", async () => {
    expect((await sandbox.execute('throw new Error("Something failed");')).result).toEqual({
      ok: false,
      error: { kind: "script", message: "Something failed" },
    });
  });

  test.each([
    ["message getter", "throw { get message() { while (true) {} } };"],
    ["toJSON", "throw { toJSON() { while (true) {} } };"],
  ])("reports timeout when error conversion loops in %s", async (_name, code) => {
    const report = await new CodemodeSandbox({ timeoutMs: 100 }).execute(code);

    expect(report.result).toEqual({
      ok: false,
      error: { kind: "timeout", message: "Execution exceeded the 100 ms limit." },
    });
  });

  test("reports thrown strings and values without messages", async () => {
    expect((await sandbox.execute('throw "Something failed";')).result).toEqual({
      ok: false,
      error: { kind: "script", message: "Something failed" },
    });
    expect((await sandbox.execute("throw null;")).result).toEqual({
      ok: false,
      error: { kind: "script", message: "Script threw a value without an error message." },
    });
  });

  test("reports syntax errors", async () => {
    const result = (await sandbox.execute("return (; ")).result;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("script");
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });

  test.each([
    ["fulfilled promise", "throw Promise.resolve(3);"],
    ["pending promise", "throw new Promise(() => {});"],
    ["promise rejected with an error", 'throw Promise.reject(new Error("inner"));'],
    ["promise rejected with a promise", "throw Promise.reject(Promise.resolve(3));"],
  ] as const)(
    "reports a thrown %s as an opaque error without awaiting or unwrapping it",
    async (_name, code) => {
      const thrown = await sandbox.execute(code);
      const next = await sandbox.execute("return 3;");

      expect(thrown.result).toEqual({
        ok: false,
        error: { kind: "script", message: "Script threw a value without an error message." },
      });
      expect(next.result).toEqual({ ok: true, value: 3 });
    },
  );

  test("awaits asynchronous return values", async () => {
    expect((await sandbox.execute("return Promise.resolve(3);")).result).toEqual({
      ok: true,
      value: 3,
    });
  });

  test.each([
    ["object", "return { then(resolve) { resolve(3); } };"],
    ["function", "const value = () => 3; value.then = resolve => resolve(3); return value;"],
  ] as const)("awaits a returned %s thenable", async (_name, code) => {
    expect((await sandbox.execute(code)).result).toEqual({ ok: true, value: 3 });
  });

  test("allows ordinary values that are not thenables", async () => {
    const result = (await sandbox.execute("return { then: 3 };")).result;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveProperty("then", 3);

    expect((await sandbox.execute("Number.prototype.then = () => {}; return 3;")).result).toEqual({
      ok: true,
      value: 3,
    });
  });

  test.each([
    ["BigInt", "return 1n;", "Do not know how to serialize a BigInt"],
    ["cycle", "const value = {}; value.self = value; return value;", "circular reference"],
    ["function", "return () => 3;", "Return value is not JSON-serializable."],
  ] as const)("reports a non-JSON %s return value", async (_name, code, message) => {
    expect((await sandbox.execute(code)).result).toEqual({
      ok: false,
      error: { kind: "script", message },
    });
  });

  test("does not expose host APIs", async () => {
    expect(
      (await sandbox.execute("return [typeof process, typeof Bun, typeof require, typeof fetch];"))
        .result,
    ).toEqual({ ok: true, value: ["undefined", "undefined", "undefined", "undefined"] });
  });

  test("continues executing after a script failure", async () => {
    const succeeded = await sandbox.execute("return 3;");
    const failed = await sandbox.execute('throw new Error("failure");');
    const recovered = await sandbox.execute("return 3;");

    expect(succeeded.result).toEqual({ ok: true, value: 3 });
    expect(failed.result).toEqual({ ok: false, error: { kind: "script", message: "failure" } });
    expect(recovered.result).toEqual({ ok: true, value: 3 });
  });
});
