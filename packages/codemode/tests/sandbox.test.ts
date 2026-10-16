import { describe, expect, test } from "bun:test";
import { CodeExecutor } from "@codemode-mcp-gateway/codemode";

describe("CodeExecutor.execute", () => {
  test("returns the result of a JavaScript function body with no tool calls", async () => {
    const sandbox = new CodeExecutor();

    const report = await sandbox.execute("return 1 + 2;");

    expect(report).toEqual({ result: { ok: true, value: 3 }, calls: [] });
  });

  test("returns objects and arrays as JSON data", async () => {
    const sandbox = new CodeExecutor();

    const report = await sandbox.execute('return { name: "mcm", values: [1, true, null] };');

    expect(report.result).toEqual({ ok: true, value: { name: "mcm", values: [1, true, null] } });
  });

  test.each([
    ["null", "return null;", null],
    ["false", "return false;", false],
    ["zero", "return 0;", 0],
    ["an empty string", 'return "";', ""],
  ] as const)("preserves %s as a return value", async (_name, code, expected) => {
    const sandbox = new CodeExecutor();

    const report = await sandbox.execute(code);

    expect(report.result).toEqual({ ok: true, value: expected });
  });

  test.each([
    ["an absent return", "const value = 3;"],
    ["an undefined return", "return undefined;"],
  ])("normalizes %s to null", async (_name, code) => {
    const sandbox = new CodeExecutor();

    const report = await sandbox.execute(code);

    expect(report.result).toEqual({ ok: true, value: null });
  });

  test("applies JSON conversion to nested undefined and non-finite numbers", async () => {
    const sandbox = new CodeExecutor();

    const report = await sandbox.execute(
      "return { omitted: undefined, values: [undefined, NaN, Infinity] };",
    );

    expect(report.result).toEqual({ ok: true, value: { values: [null, null, null] } });
  });

  test.each([
    ["a thrown string", 'throw "Something failed";', "Something failed"],
    ["a value without a message", "throw null;", "Script threw a value without an error message."],
  ])("reports %s as a script failure", async (_name, code, message) => {
    const sandbox = new CodeExecutor();

    const report = await sandbox.execute(code);

    expect(report.result).toEqual({ ok: false, error: { kind: "script", message } });
  });

  test("reports invalid syntax as a script failure", async () => {
    const sandbox = new CodeExecutor();

    const report = await sandbox.execute("return (; ");

    expect(report.result).toMatchObject({ ok: false, error: { kind: "script" } });
    if (report.result.ok) throw new Error("Expected a script failure");

    expect(report.result.error.message.length).toBeGreaterThan(0);
  });

  test.each([
    ["fulfilled promise", "throw Promise.resolve(3);"],
    ["pending promise", "throw new Promise(() => {});"],
    ["promise rejected with an error", 'throw Promise.reject(new Error("inner"));'],
    ["promise rejected with a promise", "throw Promise.reject(Promise.resolve(3));"],
  ])("treats a thrown %s as opaque and permits recovery", async (_name, code) => {
    const sandbox = new CodeExecutor();

    const thrown = await sandbox.execute(code);
    const recovered = await sandbox.execute("return 3;");

    expect(thrown.result).toEqual({
      ok: false,
      error: { kind: "script", message: "Script threw a value without an error message." },
    });
    expect(recovered.result).toEqual({ ok: true, value: 3 });
  });

  test.each([
    ["top-level await", "const value = await Promise.resolve(3); return value;"],
    ["a returned promise", "return Promise.resolve(3);"],
    ["an object thenable", "return { then(resolve) { resolve(3); } };"],
    [
      "a function thenable",
      "const value = () => 3; value.then = resolve => resolve(3); return value;",
    ],
  ])("awaits %s before returning its value", async (_name, code) => {
    const sandbox = new CodeExecutor();

    const report = await sandbox.execute(code);

    expect(report.result).toEqual({ ok: true, value: 3 });
  });

  test("preserves an object whose then property is not callable", async () => {
    const sandbox = new CodeExecutor();

    const report = await sandbox.execute("return { then: 3 };");

    expect(report.result.ok).toBe(true);
    if (!report.result.ok) throw new Error("Expected an ordinary object result");

    expect(report.result.value).toHaveProperty("then", 3);
  });

  test("does not assimilate a primitive through its prototype's then method", async () => {
    const sandbox = new CodeExecutor();

    const report = await sandbox.execute("Number.prototype.then = () => {}; return 3;");

    expect(report.result).toEqual({ ok: true, value: 3 });
  });

  test.each([
    ["BigInt", "return 1n;", "Do not know how to serialize a BigInt"],
    ["cycle", "const value = {}; value.self = value; return value;", "circular reference"],
    ["function", "return () => 3;", "Return value is not JSON-serializable."],
  ])("reports a non-JSON %s return value as a script failure", async (_name, code, message) => {
    const sandbox = new CodeExecutor();

    const report = await sandbox.execute(code);

    expect(report.result).toEqual({ ok: false, error: { kind: "script", message } });
  });

  test("continues executing after a script failure", async () => {
    const sandbox = new CodeExecutor();
    const succeeded = await sandbox.execute("return 3;");

    const failed = await sandbox.execute('throw new Error("failure");');
    const recovered = await sandbox.execute("return 3;");

    expect(succeeded.result).toEqual({ ok: true, value: 3 });
    expect(failed.result).toEqual({ ok: false, error: { kind: "script", message: "failure" } });
    expect(recovered.result).toEqual({ ok: true, value: 3 });
  });
});
