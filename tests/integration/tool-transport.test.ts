import { describe, expect, test } from "bun:test";
import { isMainThread } from "node:worker_threads";
import { CodemodeSandbox, ToolResult } from "../../src/codemode";

describe("host tool transport", () => {
  test("keeps the dispatcher, resolver map, and settlement API out of submitted lexical scope", async () => {
    const sandbox = new CodemodeSandbox({ tools: { read: () => ToolResult.success(42) } });

    const report = await sandbox.execute(`
      await tools.read();
      return [
        typeof dispatch, typeof pending, typeof settle, typeof nextCallId,
        eval("typeof dispatch"), Function("return typeof pending")(),
        typeof globalThis.run, typeof globalThis.settle,
      ];
    `);

    expect(report.result).toEqual({ ok: true, value: Array(8).fill("undefined") });
  });

  test("releases the call slot before decoded-result then getters start another call", async () => {
    const sandbox = new CodemodeSandbox({
      tools: {
        read: () => ToolResult.success({ marker: true }),
        follow: () => ToolResult.success(),
      },
      maxConcurrentToolCalls: 1,
    });

    const report = await sandbox.execute(`
      Object.defineProperty(Object.prototype, "then", {
        get() {
          if (this.marker === true) tools.follow();
          return undefined;
        }
      });
      return (await tools.read()).marker;
    `);

    expect(report.result).toEqual({ ok: true, value: true });
    expect(report.calls.map((call) => call.name)).toEqual(["read", "follow"]);
  });

  test("keeps private promise bookkeeping intact when guest built-ins are replaced", async () => {
    const sandbox = new CodemodeSandbox({
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
    const argumentsSeen: unknown[] = [];

    const sandbox = new CodemodeSandbox({
      tools: {
        read: (args) => {
          argumentsSeen.push(args);

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
    expect(argumentsSeen).toEqual(["guest-converted", undefined]);
    expect(report.calls.map((call) => call.callId)).toEqual([1, 2]);
  });

  test("keeps embedded NUL and lone-surrogate tool names distinct", async () => {
    const names = ["a", "a\u0000b", "a\ud800", "a\ufffd", ""];
    const tools = Object.fromEntries(names.map((name) => [name, () => ToolResult.success(name)]));
    const sandbox = new CodemodeSandbox({ tools });

    const report = await sandbox.execute(
      `return await Promise.all(${JSON.stringify(names)}.map(name => tools[name]()));`,
    );

    expect(report.result).toEqual({ ok: true, value: names });
    expect(report.calls.map((call) => call.name)).toEqual(names);
  });

  test("delivers the complete public failure message despite guest-global mutations", async () => {
    const message = "before\u0000after\ud800";
    const sandbox = new CodemodeSandbox({ tools: { fail: () => ToolResult.failure(message) } });

    const report = await sandbox.execute(`
      JSON.parse = JSON.stringify = () => "replaced";
      try { await tools.fail(); } catch (error) { error.message += "!"; return error.message; }
    `);

    expect(report.result).toEqual({ ok: true, value: message + "!" });
    expect(report.calls).toEqual([
      { callId: 1, name: "fail", status: "completed", result: ToolResult.failure(message) },
    ]);
  });

  test("transfers only the public message from explicit failure envelopes", async () => {
    const failure = {
      ok: false,
      error: { message: "Public failure", diagnostics: () => "Private error details" },
      privateCallback: () => {},
    } as const;

    const result = (
      await new CodemodeSandbox({
        tools: {
          read: () => failure,
        },
      }).execute("try { await tools.read(); } catch (error) { return error.message; }")
    ).result;

    expect(result).toEqual({ ok: true, value: "Public failure" });
  });

  test("keeps callbacks and JSON conversion on the main thread", async () => {
    let conversions = 0;

    const result = (
      await new CodemodeSandbox({
        tools: {
          read: () =>
            ToolResult.success({
              toJSON() {
                conversions += 1;

                return { mainThread: isMainThread, omitted: undefined, values: [undefined, NaN] };
              },
            }),
        },
      }).execute("return await tools.read();")
    ).result;

    expect(result).toEqual({ ok: true, value: { mainThread: true, values: [null, null] } });
    expect(conversions).toBe(1);
  });

  test("supports special tool names without inherited dispatch", async () => {
    const tools = Object.fromEntries(
      ["__proto__", "constructor", "toString"].map((name) => [
        name,
        () => ToolResult.success(name),
      ]),
    );

    const result = (
      await new CodemodeSandbox({ tools }).execute(
        "return await Promise.all([tools.__proto__(), tools.constructor(), tools.toString()]);",
      )
    ).result;

    expect(result).toEqual({ ok: true, value: ["__proto__", "constructor", "toString"] });
  });

  test("snapshots the supplied registry before worker startup", async () => {
    const tools = { read: () => ToolResult.success(1) };

    const completion = new CodemodeSandbox({ tools }).execute("return await tools.read();");
    tools.read = () => ToolResult.success(2);

    expect((await completion).result).toEqual({ ok: true, value: 1 });
  });
});
