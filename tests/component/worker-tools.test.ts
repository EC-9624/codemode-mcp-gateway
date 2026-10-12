import { describe, expect, spyOn, test } from "bun:test";
import { execute, ToolResult, type SandboxTool } from "../../src/codemode";
import { executionErrorOf } from "../support/execution-error";
import { superviseWorker, faultWorker, toolWorker } from "../support/workers";

describe("worker host tools", () => {
  test("rejects reply transport failures without turning them into guest tool errors", async () => {
    const worker = toolWorker('try { return await tools.read(); } catch { return "caught"; }');
    const failure = new Error("Private reply transport failure");

    using post = spyOn(worker, "postMessage").mockImplementation(() => {
      throw failure;
    });

    const error = await executionErrorOf(
      superviseWorker(worker, { tools: { read: () => ToolResult.success(42) } }),
    );

    expect(error.cause).toBe(failure);
    expect(error.calls).toEqual([
      { callId: 1, name: "read", status: "completed", result: { ok: true, json: "42" } },
    ]);
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
        await executionErrorOf(
          superviseWorker(worker, { tools: { read: () => ToolResult.success(42) } }),
        )
      ).cause;

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
      await executionErrorOf(
        superviseWorker(worker, { tools: { read: () => ToolResult.success(42) } }),
      )
    ).cause;

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

      const completion = superviseWorker(worker, {
        tools: {
          read: () => {
            calls += 1;

            return ToolResult.success();
          },
        },
      });

      worker.emit("message", call);
      const error = await executionErrorOf(completion);

      expect(error.cause).toBeInstanceOf(Error);
      expect(error.calls).toEqual([]);
      expect(calls).toBe(0);
    });
  }

  test("rejects replayed call IDs without dispatching twice", async () => {
    const worker = toolWorker("return 42;");
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));
    let calls = 0;

    const completion = superviseWorker(worker, {
      tools: {
        read: () => {
          calls += 1;

          return late.promise;
        },
      },
    });

    const call = { type: "tool-call", callId: 1, name: "read", argsJson: undefined };
    worker.emit("message", call);
    worker.emit("message", call);
    expect((await executionErrorOf(completion)).cause).toBeInstanceOf(Error);
    expect(calls).toBe(1);
  });

  test("discards late results after timeout without conversion or transport", async () => {
    const worker = toolWorker("return await tools.read();", 100);
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));
    let conversions = 0;
    using post = spyOn(worker, "postMessage");

    const report = await superviseWorker(worker, { tools: { read: () => late.promise } });

    expect(report.result).toEqual({
      ok: false,
      error: { kind: "timeout", message: "Execution exceeded the 100 ms limit." },
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
    const worker = faultWorker("call-and-crash", ["read"]);
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));
    using post = spyOn(worker, "postMessage");

    const read: SandboxTool = () => {
      worker.postMessage("crash now");

      return late.promise;
    };

    const failure = (await executionErrorOf(superviseWorker(worker, { tools: { read } }))).cause;

    expect(failure).toBeInstanceOf(Error);
    if (failure instanceof Error) expect(failure.message).not.toContain("Private fixture");

    late.reject(new Error("Private late failure"));
    await Bun.sleep(0);
    expect(post).toHaveBeenCalledTimes(1);
    expect((await execute("return 42;")).result).toEqual({ ok: true, value: 42 });
  });
});
