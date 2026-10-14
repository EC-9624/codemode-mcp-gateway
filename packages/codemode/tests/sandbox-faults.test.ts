import { describe, expect, spyOn, test } from "bun:test";
import { Scope } from "quickjs-emscripten";
import { DEFAULT_LIMITS } from "../src/runtime/limits.ts";
import { createVm } from "../src/runtime/vm.ts";
import { ToolResult } from "@cmg/codemode";
import { executeEngine } from "../src/runtime/engine.ts";
import { expectDisposedExecution, type ExecutionResources } from "./support/disposal.ts";
import { executeLocally, installLocalToolBridge, prepareTools } from "./support/local-tools.ts";
import { GuestCall } from "../src/runtime/protocol.ts";
import { installGuestToolBridge } from "../src/runtime/guest-bridge.ts";
import { rejectionOf } from "./support/rejection.ts";
import { interruptFlag } from "./support/workers.ts";

// Submitted code cannot access the dispatcher, settlement handle, or VM allocation APIs.
// Direct probes are limited to corrupt-boundary handling, no retry, disposal, and original causes.

describe("guest tool bridge", () => {
  test.each([
    ["an unknown tool", [{ type: "call", callId: 1, name: "unknown", argsJson: null }], 0],
    [
      "a replayed ID",
      [
        { type: "call", callId: 1, name: "read", argsJson: null },
        { type: "call", callId: 1, name: "read", argsJson: null },
      ],
      1,
    ],
  ] as const)("rejects %s before additional dispatch", async (_name, calls, count) => {
    let dispatched = 0;

    using vm = await createVm();
    using scope = new Scope();

    const bridge = installGuestToolBridge(
      vm,
      ["read"],
      () => {
        dispatched++;
      },
      scope,
      DEFAULT_LIMITS,
    );

    vm.setProp(vm.global, "send", bridge.dispatcher);

    for (const call of calls) {
      using result = vm.evalCode(`send(${JSON.stringify(JSON.stringify(call))});`);

      expect(result.error).toBeUndefined();
    }

    expect(dispatched).toBe(count);
    expect(bridge.failure).toEqual({
      kind: "error",
      error: new Error("Sandbox guest requested an unknown tool or invalid call ID."),
    });
  });

  test("settles a guest promise once and rejects a duplicate host reply", async () => {
    using vm = await createVm();
    using scope = new Scope();
    const bridge = installGuestToolBridge(vm, ["read"], () => {}, scope, DEFAULT_LIMITS);
    prepareTools(vm, bridge);
    using settlement = spyOn(vm, "callFunction");

    using started = vm.evalCode("tools.read();");
    expect(started.error).toBeUndefined();
    expect(bridge.pendingCalls.size).toBe(1);
    const changed = bridge.changeSignal;
    const reply = { type: "tool-result", callId: 1, result: { ok: true, json: "42" } } as const;
    bridge.receive(reply);
    await changed;
    bridge.receive(reply);

    expect(bridge.pendingCalls.size).toBe(0);
    expect(settlement).toHaveBeenCalledTimes(1);
    expect(bridge.failure).toEqual({
      kind: "error",
      error: new Error("Sandbox worker received an unknown or duplicate tool reply."),
    });
  });

  test("treats a guest settlement exception as terminal infrastructure failure without retry", async () => {
    using vm = await createVm();
    using scope = new Scope();
    const bridge = installGuestToolBridge(vm, ["read"], () => {}, scope, DEFAULT_LIMITS);

    using api = vm
      .evalCode('({ settle() { throw new Error("Private settlement failure"); } })')
      .unwrap();

    bridge.attach(api);
    vm.setProp(vm.global, "send", bridge.dispatcher);

    using started = vm.evalCode(
      'send(JSON.stringify({ type: "call", callId: 1, name: "read", argsJson: null }));',
    );

    expect(started.error).toBeUndefined();
    using settlement = spyOn(vm, "callFunction");

    bridge.receive({ type: "tool-result", callId: 1, result: { ok: true, json: "42" } });
    bridge.receive({
      type: "tool-result",
      callId: 1,
      result: { ok: false, error: { message: "retry" } },
    });

    expect(settlement).toHaveBeenCalledTimes(1);
    expect(bridge.failure).toEqual({
      kind: "error",
      error: new Error("Sandbox guest settlement failed."),
    });
  });

  test("ignores late replies after disposing the owned bridge handles", async () => {
    using vm = await createVm();
    const scope = new Scope();
    const bridge = installGuestToolBridge(vm, ["read"], () => {}, scope, DEFAULT_LIMITS);
    try {
      prepareTools(vm, bridge);
      using started = vm.evalCode("tools.read();");
      expect(started.error).toBeUndefined();
    } finally {
      scope.dispose();
    }

    using allocation = spyOn(vm, "newString");
    using settlement = spyOn(vm, "callFunction");
    bridge.receive({ type: "tool-result", callId: 1, result: { ok: true, json: "42" } });

    expect(bridge.dispatcher.alive).toBe(false);
    expect(allocation).not.toHaveBeenCalled();
    expect(settlement).not.toHaveBeenCalled();
    expect(bridge.failure).toBeUndefined();
  });

  test("rejects a corrupt guest envelope before host dispatch", async () => {
    using vm = await createVm();
    using scope = new Scope();
    let calls = 0;

    const bridge = installLocalToolBridge(
      vm,
      {
        echo: (args) => {
          calls += 1;

          return ToolResult.success(args);
        },
      },
      scope,
    );

    vm.setProp(vm.global, "send", bridge.dispatcher);

    using result = vm.evalCode('send("not JSON");');

    expect(result.error).toBeUndefined();
    expect(bridge.failure).toEqual({
      kind: "error",
      error: new Error("Sandbox guest sent an invalid tool call."),
    });
    expect(calls).toBe(0);
    expect(bridge.pendingCalls.size).toBe(0);
  });

  test.each([
    ["newString", ToolResult.success(42)],
    ["callFunction", ToolResult.failure("Public failure")],
  ] as const)(
    "propagates %s failure without retrying settlement as a tool rejection",
    async (method, response) => {
      using vm = await createVm();
      using scope = new Scope();
      const bridge = installLocalToolBridge(vm, { answer: () => response }, scope);
      prepareTools(vm, bridge);
      const failure = new Error("VM infrastructure failed");

      using fault = spyOn(vm, method).mockImplementation(() => {
        throw failure;
      });

      using guestErrors = spyOn(vm, "newError");

      using result = vm.evalCode("tools.answer();");

      expect(result.error).toBeUndefined();
      await bridge.failureSignal;
      expect(bridge.failure).toEqual({ kind: "error", error: failure });
      expect(fault).toHaveBeenCalledTimes(1);
      expect(guestErrors).not.toHaveBeenCalled();
    },
  );

  for (const [name, code] of [
    ["guest try/catch", "try { await tools.read(); } catch (error) { return error.message; }"],
    ["a loop in a resumed job", "await Promise.resolve(); tools.read(); while (true) {}"],
    ["guest error conversion", 'throw { get message() { tools.read(); return "Guest error"; } };'],
  ] as const) {
    test(`synchronous dispatcher failure ends execution despite ${name}`, async () => {
      const failure = new Error("Private dispatcher details");
      using cleanup = new DisposableStack();
      let decodes = 0;
      let calls = 0;
      let guestErrors = 0;
      const resources: ExecutionResources[] = [];

      const completion = executeEngine(
        code,
        { ...DEFAULT_LIMITS, timeoutMs: 1000 },
        (vm, scope) => {
          resources.push({ vm, scope });

          const fault = spyOn(GuestCall, "decode").mockImplementation(() => {
            decodes += 1;
            throw failure;
          });

          const newError = vm.newError.bind(vm);

          const errors = spyOn(vm, "newError").mockImplementation(
            (...args: Parameters<typeof vm.newError>) => {
              guestErrors += 1;

              return newError(...args);
            },
          );

          cleanup.defer(() => fault.mockRestore());
          cleanup.defer(() => errors.mockRestore());

          return installLocalToolBridge(
            vm,
            {
              read: () => {
                calls += 1;

                return ToolResult.success(42);
              },
            },
            scope,
          );
        },
        interruptFlag(),
      );

      expect((await rejectionOf(completion)).reason).toBe(failure);
      expect(decodes).toBe(1);
      expect(calls).toBe(0);
      expect(guestErrors).toBe(0);
      expectDisposedExecution(resources);
    });
  }

  test("propagates infrastructure failures even while guest jobs keep arriving", async () => {
    const failure = new Error("VM allocation failed");
    using cleanup = new DisposableStack();
    const resources: ExecutionResources[] = [];

    const completion = executeEngine(
      "tools.answer(); while (true) await Promise.resolve();",
      { ...DEFAULT_LIMITS, timeoutMs: 1000 },
      (vm, scope) => {
        resources.push({ vm, scope });

        return installLocalToolBridge(
          vm,
          {
            answer: () => {
              // Injecting during setup would not exercise bridge settlement while guest jobs arrive.
              const fault = spyOn(vm, "newString").mockImplementation(() => {
                throw failure;
              });

              cleanup.defer(() => fault.mockRestore());

              return ToolResult.success(42);
            },
          },
          scope,
        );
      },
      interruptFlag(),
    );

    expect((await rejectionOf(completion)).reason).toBe(failure);
    expectDisposedExecution(resources);

    cleanup.dispose();
    expect(await executeLocally("return 3;")).toEqual({ ok: true, value: 3 });
  });
});
