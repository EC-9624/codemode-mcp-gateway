import { describe, expect, spyOn, test } from "bun:test";
import { Scope } from "quickjs-emscripten";
import { DEFAULT_LIMITS } from "../../src/codemode/runtime/limits";
import { createVm } from "../../src/codemode/runtime/vm";
import { ToolResult } from "../../src/codemode";
import { executeEngine } from "../../src/codemode/runtime/engine";
import { expectDisposedExecution, type ExecutionResources } from "../support/disposal";
import { executeLocally, installLocalToolBridge } from "../support/local-tools";
import { rejectionOf } from "../support/rejection";
import { interruptFlag } from "../support/workers";

describe("guest tool bridge", () => {
  test.each([
    ["non-JSON argument text", 'tools.echo("not JSON");'],
    ["non-string arguments", "tools.echo({});"],
  ] as const)(
    "rejects low-level bridge calls with %s before host dispatch",
    async (_name, code) => {
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

      using result = vm.evalCode(code);

      expect(result.error).toBeDefined();
      expect(calls).toBe(0);
      expect(bridge.pendingCalls.size).toBe(0);
    },
  );

  test.each(["newString", "callFunction"] as const)(
    "propagates %s failure without retrying settlement as a tool rejection",
    async (method) => {
      using vm = await createVm();
      using scope = new Scope();
      const bridge = installLocalToolBridge(vm, { answer: () => ToolResult.success(42) }, scope);
      const failure = new Error("VM infrastructure failed");

      using fault = spyOn(vm, method).mockImplementation(() => {
        throw failure;
      });

      using guestErrors = spyOn(vm, "newError");

      using result = vm.evalCode("tools.answer();");

      expect(result.error).toBeUndefined();
      expect((await rejectionOf(Promise.all(bridge.pendingCalls))).reason).toBe(failure);
      expect(fault).toHaveBeenCalledTimes(1);
      expect(guestErrors).not.toHaveBeenCalled();
    },
  );

  for (const [name, code] of [
    ["guest try/catch", "try { await tools.read(); } catch (error) { return error.message; }"],
    [
      "a resumed guest job",
      "await Promise.resolve(); try { await tools.read(); } catch (error) { return error.message; }",
    ],
    ["another tool call", "tools.read(); tools.read(); return 42;"],
    ["a synchronous loop", "tools.read(); while (true) {}"],
    ["a loop in a resumed job", "await Promise.resolve(); tools.read(); while (true) {}"],
    ["a later guest exception", 'tools.read(); throw new Error("Guest error");'],
    ["guest error conversion", 'throw { get message() { tools.read(); return "Guest error"; } };'],
  ] as const) {
    test(`synchronous promise allocation failure ends execution despite ${name}`, async () => {
      const failure = new Error("Private allocation details");
      using cleanup = new DisposableStack();
      let allocations = 0;
      let calls = 0;
      let guestErrors = 0;
      const resources: ExecutionResources[] = [];

      const completion = executeEngine(
        code,
        { ...DEFAULT_LIMITS, timeoutMs: 1000 },
        (vm, scope) => {
          resources.push({ vm, scope });

          const fault = spyOn(vm, "newPromise").mockImplementation(() => {
            allocations += 1;
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
      expect(allocations).toBe(1);
      expect(calls).toBe(0);
      expect(guestErrors).toBe(0);
      expectDisposedExecution(resources);
    });
  }

  test.each([
    ["typeof", 'tools.read("42");'],
    ["getString", 'tools.read("42");'],
    ["newError", "tools.read({});"],
  ] as const)(
    "records synchronous %s failure before returning to the guest",
    async (method, code) => {
      using vm = await createVm();
      using scope = new Scope();
      let calls = 0;

      const bridge = installLocalToolBridge(
        vm,
        {
          read: () => {
            calls += 1;

            return ToolResult.success(42);
          },
        },
        scope,
      );

      const failure = new Error("Private synchronous bridge failure");

      using fault = spyOn(vm, method).mockImplementation(() => {
        throw failure;
      });

      using result = vm.evalCode(code);

      expect(result.error).toBeUndefined();
      expect(bridge.failure).toEqual({ kind: "error", error: failure });
      await bridge.failureSignal;
      expect(bridge.pendingCalls.size).toBe(0);
      expect(calls).toBe(0);
      expect(fault).toHaveBeenCalledTimes(1);
    },
  );

  test("propagates VM failures while rejecting an explicit tool failure", async () => {
    using vm = await createVm();
    using scope = new Scope();

    const bridge = installLocalToolBridge(
      vm,
      { fail: () => ToolResult.failure("Public failure") },
      scope,
    );

    const failure = new Error("VM infrastructure failed");

    using fault = spyOn(vm, "newError").mockImplementation(() => {
      throw failure;
    });

    using result = vm.evalCode("tools.fail();");

    expect(result.error).toBeUndefined();
    expect((await rejectionOf(Promise.all(bridge.pendingCalls))).reason).toBe(failure);
    expect(fault).toHaveBeenCalledTimes(1);
  });

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
