import { describe, expect, spyOn, test } from "bun:test";
import { isMainThread, Worker } from "node:worker_threads";
import { execute, ToolResult, type SandboxTool } from "../src/sandbox";
import { superviseWorker } from "../src/worker-execution";
import { ToolReply, WorkerStartupData, WorkerToMainMessage } from "../src/worker-protocol";
import { rejectionOf } from "./rejection";

describe("worker tool protocol", () => {
  test("requires a dense list of unique string tool names", () => {
    for (const toolNames of [null, [42], ["read", "read"], Array(1)]) {
      expect(WorkerStartupData.decode({ type: "execute", code: "return 42;", toolNames }).ok).toBe(
        false,
      );
    }
    expect(WorkerStartupData.decode({ type: "execute", code: "return 42;" }).ok).toBe(false);
  });

  test("accepts JSON text and undefined arguments and results", () => {
    for (const argsJson of [undefined, "null", '"hello"', '{"value":42}']) {
      const value = { type: "tool-call", callId: 1, name: "read", argsJson } as const;
      expect(WorkerToMainMessage.decode(value)).toEqual({ ok: true, value });
      const reply = {
        type: "tool-result",
        callId: 1,
        result: { ok: true, json: argsJson },
      } as const;
      expect(ToolReply.decode(reply)).toEqual({ ok: true, value: reply });
    }
  });

  test("accepts explicit tool failure messages", () => {
    const failure = {
      type: "tool-result",
      callId: 1,
      result: ToolResult.failure("Public failure"),
    } as const;
    expect(ToolReply.decode(failure)).toEqual({ ok: true, value: failure });
  });

  test("requires positive safe-integer call IDs in both directions", () => {
    for (const callId of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"]) {
      expect(
        WorkerToMainMessage.decode({ type: "tool-call", callId, name: "read", argsJson: undefined })
          .ok,
      ).toBe(false);
      expect(
        ToolReply.decode({ type: "tool-result", callId, result: { ok: true, json: "42" } }).ok,
      ).toBe(false);
    }
  });

  test("rejects arguments and results that are not JSON text or undefined", () => {
    for (const argsJson of [42, {}, "undefined", "not JSON"]) {
      expect(
        WorkerToMainMessage.decode({ type: "tool-call", callId: 1, name: "read", argsJson }).ok,
      ).toBe(false);
      expect(
        ToolReply.decode({ type: "tool-result", callId: 1, result: { ok: true, json: argsJson } })
          .ok,
      ).toBe(false);
    }
  });

  test("rejects replies without a serialized value or public failure message", () => {
    for (const result of [null, {}, { ok: true }, { ok: false, error: { message: 42 } }]) {
      expect(ToolReply.decode({ type: "tool-result", callId: 1, result }).ok).toBe(false);
    }
  });
});

describe("worker host tools", () => {
  test("transfers only the public message from explicit failure envelopes", async () => {
    const result = {
      ok: false,
      error: { message: "Public failure", diagnostics: () => "Private error details" },
      privateCallback: () => {},
    } as const;
    expect(
      await execute("try { await tools.read(); } catch (error) { return error.message; }", {
        read: () => result,
      }),
    ).toEqual({ ok: true, value: "Public failure" });
  });

  test("keeps callbacks and JSON conversion on the main thread", async () => {
    let conversions = 0;
    expect(
      await execute("return await tools.read();", {
        read: () =>
          ToolResult.success({
            toJSON() {
              conversions += 1;
              return { mainThread: isMainThread, omitted: undefined, values: [undefined, NaN] };
            },
          }),
      }),
    ).toEqual({ ok: true, value: { mainThread: true, values: [null, null] } });
    expect(conversions).toBe(1);
  });

  test("routes replies that complete in reverse invocation order", async () => {
    const second = Promise.withResolvers<void>();
    const order: number[] = [];
    expect(
      await execute("return await Promise.all([tools.read(1), tools.read(2)]);", {
        read: async (args) => {
          if (args === 1) await second.promise;
          if (typeof args !== "number") return ToolResult.failure("Expected a number");
          order.push(args);
          if (args === 2) second.resolve();
          return ToolResult.success(args);
        },
      }),
    ).toEqual({ ok: true, value: [1, 2] });
    expect(order).toEqual([2, 1]);
  });

  test("supports special tool names without inherited dispatch", async () => {
    const tools = Object.fromEntries(
      ["__proto__", "constructor", "toString"].map((name) => [
        name,
        () => ToolResult.success(name),
      ]),
    );
    expect(
      await execute(
        "return await Promise.all([tools.__proto__(), tools.constructor(), tools.toString()]);",
        tools,
      ),
    ).toEqual({ ok: true, value: ["__proto__", "constructor", "toString"] });
  });

  test("snapshots the supplied registry before worker startup", async () => {
    const tools = { read: () => ToolResult.success(1) };
    const completion = execute("return await tools.read();", tools);
    tools.read = () => ToolResult.success(2);
    expect(await completion).toEqual({ ok: true, value: 1 });
  });

  test("preserves undefined tool results rather than turning them into null", async () => {
    expect(
      await execute("return (await tools.read()) === undefined;", {
        read: () => ToolResult.success(),
      }),
    ).toEqual({ ok: true, value: true });
  });

  test("rejects reply transport failures without turning them into guest tool errors", async () => {
    const worker = toolWorker('try { return await tools.read(); } catch { return "caught"; }');
    const failure = new Error("Private reply transport failure");
    using post = spyOn(worker, "postMessage").mockImplementation(() => {
      throw failure;
    });
    expect(
      (
        await rejectionOf(
          superviseWorker(worker, new Map([["read", () => ToolResult.success(42)]])),
        )
      ).reason,
    ).toBe(failure);
    expect(post).toHaveBeenCalledTimes(1);
  });

  for (const [name, reply] of [
    ["malformed JSON", { type: "tool-result", callId: 1, result: { ok: true, json: "not JSON" } }],
    ["unmatched call IDs", { type: "tool-result", callId: 2, result: { ok: true, json: "42" } }],
  ] as const) {
    test(`rejects replies with ${name} as infrastructure failures`, async () => {
      const worker = toolWorker('try { return await tools.read(); } catch { return "caught"; }');
      const send = worker.postMessage.bind(worker);
      using post = spyOn(worker, "postMessage").mockImplementation(() => send(reply));
      const failure = (
        await rejectionOf(
          superviseWorker(worker, new Map([["read", () => ToolResult.success(42)]])),
        )
      ).reason;
      expect(failure).toBeInstanceOf(Error);
      if (failure instanceof Error)
        expect(failure.message).toContain("Sandbox worker execution failed.");
      expect(post).toHaveBeenCalledTimes(1);
    });
  }

  test("observes duplicate replies even while guest jobs keep arriving", async () => {
    const worker = toolWorker("tools.read(); while (true) await Promise.resolve();");
    const send = worker.postMessage.bind(worker);
    using post = spyOn(worker, "postMessage").mockImplementation((value: unknown) => {
      send(value);
      send(value);
    });
    const failure = (
      await rejectionOf(superviseWorker(worker, new Map([["read", () => ToolResult.success(42)]])))
    ).reason;
    expect(failure).toBeInstanceOf(Error);
    if (failure instanceof Error)
      expect(failure.message).toContain("Sandbox worker execution failed.");
    expect(post).toHaveBeenCalledTimes(1);
  });

  for (const [name, call] of [
    ["unknown tools", { type: "tool-call", callId: 1, name: "toString", argsJson: undefined }],
    ["malformed arguments", { type: "tool-call", callId: 1, name: "read", argsJson: "not JSON" }],
    ["skipped call IDs", { type: "tool-call", callId: 2, name: "read", argsJson: undefined }],
  ] as const) {
    test(`rejects ${name} without dispatching a callback`, async () => {
      const worker = toolWorker("return 42;");
      let calls = 0;
      const completion = superviseWorker(
        worker,
        new Map([
          [
            "read",
            () => {
              calls += 1;
              return ToolResult.success();
            },
          ],
        ]),
      );
      worker.emit("message", call);
      expect((await rejectionOf(completion)).reason).toBeInstanceOf(Error);
      expect(calls).toBe(0);
    });
  }

  test("rejects replayed call IDs without dispatching twice", async () => {
    const worker = toolWorker("return 42;");
    const late = Promise.withResolvers<ToolResult>();
    let calls = 0;
    const completion = superviseWorker(
      worker,
      new Map([
        [
          "read",
          () => {
            calls += 1;
            return late.promise;
          },
        ],
      ]),
    );
    const call = { type: "tool-call", callId: 1, name: "read", argsJson: undefined };
    worker.emit("message", call);
    worker.emit("message", call);
    expect((await rejectionOf(completion)).reason).toBeInstanceOf(Error);
    expect(calls).toBe(1);
    late.resolve(ToolResult.success());
  });

  test("discards late results after timeout without conversion or transport", async () => {
    const worker = toolWorker("return await tools.read();");
    const late = Promise.withResolvers<ToolResult>();
    let conversions = 0;
    using post = spyOn(worker, "postMessage");
    expect(await superviseWorker(worker, new Map([["read", () => late.promise]]))).toEqual({
      ok: false,
      error: { kind: "timeout", message: "Execution exceeded the 1-second limit." },
    });
    late.resolve(
      ToolResult.success({
        toJSON() {
          conversions += 1;
          return 42;
        },
      }),
    );
    await Bun.sleep(0);
    expect(conversions).toBe(0);
    expect(post).not.toHaveBeenCalled();
  });

  test("observes late callback failures after a worker crash", async () => {
    const worker = new Worker(new URL("./fixtures/worker-fault.ts", import.meta.url), {
      workerData: { type: "execute", code: "call-and-crash", toolNames: ["read"] },
    });
    const late = Promise.withResolvers<ToolResult>();
    using post = spyOn(worker, "postMessage");
    const read: SandboxTool = () => {
      worker.postMessage("crash now");
      return late.promise;
    };
    const failure = (await rejectionOf(superviseWorker(worker, new Map([["read", read]])))).reason;
    expect(failure).toBeInstanceOf(Error);
    if (failure instanceof Error) expect(failure.message).not.toContain("Private fixture");
    late.reject(new Error("Private late failure"));
    await Bun.sleep(0);
    expect(post).toHaveBeenCalledTimes(1);
    expect(await execute("return 42;")).toEqual({ ok: true, value: 42 });
  });
});

function toolWorker(code: string) {
  return new Worker(new URL("../src/worker-entry.ts", import.meta.url), {
    workerData: { type: "execute", code, toolNames: ["read"] } satisfies WorkerStartupData,
  });
}
