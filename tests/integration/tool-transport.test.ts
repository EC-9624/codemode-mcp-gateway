import { describe, expect, test } from "bun:test";
import { isMainThread } from "node:worker_threads";
import { execute, ToolResult } from "../../src/sandbox";

describe("host tool transport", () => {
  test("transfers only the public message from explicit failure envelopes", async () => {
    const failure = {
      ok: false,
      error: { message: "Public failure", diagnostics: () => "Private error details" },
      privateCallback: () => {},
    } as const;

    const result = await execute(
      "try { await tools.read(); } catch (error) { return error.message; }",
      { read: () => failure },
    );

    expect(result).toEqual({ ok: true, value: "Public failure" });
  });

  test("keeps callbacks and JSON conversion on the main thread", async () => {
    let conversions = 0;

    const result = await execute("return await tools.read();", {
      read: () =>
        ToolResult.success({
          toJSON() {
            conversions += 1;

            return { mainThread: isMainThread, omitted: undefined, values: [undefined, NaN] };
          },
        }),
    });

    expect(result).toEqual({ ok: true, value: { mainThread: true, values: [null, null] } });
    expect(conversions).toBe(1);
  });

  test("routes replies that complete in reverse invocation order", async () => {
    const second = Promise.withResolvers<void>();
    const order: number[] = [];

    const result = await execute("return await Promise.all([tools.read(1), tools.read(2)]);", {
      read: async (args) => {
        if (args === 1) await second.promise;

        if (typeof args !== "number") return ToolResult.failure("Expected a number");

        order.push(args);
        if (args === 2) second.resolve();

        return ToolResult.success(args);
      },
    });

    expect(result).toEqual({ ok: true, value: [1, 2] });
    expect(order).toEqual([2, 1]);
  });

  test("supports special tool names without inherited dispatch", async () => {
    const tools = Object.fromEntries(
      ["__proto__", "constructor", "toString"].map((name) => [
        name,
        () => ToolResult.success(name),
      ]),
    );

    const result = await execute(
      "return await Promise.all([tools.__proto__(), tools.constructor(), tools.toString()]);",
      tools,
    );

    expect(result).toEqual({ ok: true, value: ["__proto__", "constructor", "toString"] });
  });

  test("snapshots the supplied registry before worker startup", async () => {
    const tools = { read: () => ToolResult.success(1) };

    const completion = execute("return await tools.read();", tools);
    tools.read = () => ToolResult.success(2);

    expect(await completion).toEqual({ ok: true, value: 1 });
  });

  test("preserves undefined tool results rather than turning them into null", async () => {
    const result = await execute("return (await tools.read()) === undefined;", {
      read: () => ToolResult.success(),
    });

    expect(result).toEqual({ ok: true, value: true });
  });
});
