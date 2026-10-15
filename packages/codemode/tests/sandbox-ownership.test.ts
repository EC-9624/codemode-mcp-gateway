import { expect, spyOn, test } from "bun:test";
import { getQuickJS, type QuickJSHandle } from "quickjs-emscripten";
import { Parser } from "acorn";
import { DEFAULT_LIMITS } from "../src/runtime/limits.ts";
import { ToolResult, type SandboxResult } from "@cmg/codemode";
import { executeEngine } from "../src/runtime/engine.ts";
import { createVm } from "../src/runtime/vm.ts";
import { expectDisposedExecution, type ExecutionResources } from "./support/disposal.ts";
import { executeLocally, installLocalToolBridge } from "./support/local-tools.ts";
import { rejectionOf } from "./support/rejection.ts";
import { interruptFlag } from "./support/workers.ts";

// Public execution terminates its worker, hiding VM handles and original worker-local causes.
// These probes inspect actual owned resources and failures that cannot cross that boundary.

test("final successful conversion observes the guest deadline and disposes resources", async () => {
  const resources: ExecutionResources[] = [];
  using cleanup = new DisposableStack();
  using clock = spyOn(performance, "now").mockReturnValue(0);

  const result = await executeEngine(
    "return 42;",
    { ...DEFAULT_LIMITS, timeoutMs: 1000 },
    (vm, scope) => {
      resources.push({ vm, scope });
      const getString = vm.getString.bind(vm);
      cleanup.use(
        spyOn(vm, "getString").mockImplementation((handle) => {
          const text = getString(handle);
          if (text === "42") clock.mockReturnValue(1001);

          return text;
        }),
      );

      return installLocalToolBridge(vm, {}, scope);
    },
    interruptFlag(),
  );

  expect(result).toEqual({
    ok: false,
    error: { kind: "timeout", message: "Execution exceeded the 1000 ms limit." },
  });
  expectDisposedExecution(resources);
});

test("propagates unexpected parser failures instead of reporting a script error", async () => {
  const failure = new Error("Parser infrastructure failed");

  using parser = spyOn(Parser, "parse").mockImplementation(() => {
    throw failure;
  });

  const result = await rejectionOf(executeLocally("return 3;"));

  expect(result.reason).toBe(failure);
  expect(parser).toHaveBeenCalledTimes(1);

  parser.mockRestore();
  expect(await executeLocally("return 3;")).toEqual({ ok: true, value: 3 });
});

test("preserves parent interruption during guest error conversion", async () => {
  const resources: ExecutionResources[] = [];
  const interrupt = interruptFlag();

  const result = await executeEngine(
    'throw { get message() { tools.read(); return "Guest error"; } };',
    { ...DEFAULT_LIMITS, timeoutMs: 1000 },
    (vm, scope) => {
      resources.push({ vm, scope });

      return installLocalToolBridge(
        vm,
        {
          read: () => {
            Atomics.store(interrupt, 0, 1);

            return ToolResult.success();
          },
        },
        scope,
      );
    },
    interrupt,
  );

  expect(result).toEqual({
    ok: false,
    error: { kind: "timeout", message: "Execution interrupted by the parent." },
  });
  expectDisposedExecution(resources);
});

test("disposes execution resources when the prelude cannot compile", async () => {
  const resources: ExecutionResources[] = [];

  const failure = await rejectionOf(
    executeEngine(
      "return 42;",
      { ...DEFAULT_LIMITS, memoryLimitBytes: 1 },
      (vm, scope) => {
        resources.push({ vm, scope });

        return installLocalToolBridge(vm, {}, scope);
      },
      interruptFlag(),
    ),
  );

  expect(failure.reason).toBeInstanceOf(Error);
  if (failure.reason instanceof Error) {
    expect(failure.reason.message).toBe("Sandbox prelude initialization failed.");
  }

  expectDisposedExecution(resources);
});

test("rejects prelude factory invocation failure and disposes execution resources", async () => {
  const resources: ExecutionResources[] = [];

  const failure = await rejectionOf(
    executeEngine(
      "return 42;",
      { ...DEFAULT_LIMITS, timeoutMs: 1000 },
      (vm, scope) => {
        resources.push({ vm, scope });

        // Fail a prelude dependency after compilation, before submitted code runs.
        using prepared = vm.evalCode(
          'Object.freeze = () => { throw new Error("Private prelude failure"); };',
        );

        expect(prepared.error).toBeUndefined();

        return installLocalToolBridge(vm, {}, scope);
      },
      interruptFlag(),
    ),
  );

  expect(failure.reason).toBeInstanceOf(Error);
  if (failure.reason instanceof Error) {
    expect(failure.reason.message).toBe("Sandbox prelude initialization failed.");
  }

  expectDisposedExecution(resources);
});

test("preserves timeout classification during prelude initialization", async () => {
  const resources: ExecutionResources[] = [];

  const result = await executeEngine(
    "return 42;",
    { ...DEFAULT_LIMITS, timeoutMs: 100 },
    (vm, scope) => {
      resources.push({ vm, scope });
      // Keep the prelude busy until the real guest deadline interrupts it.
      using prepared = vm.evalCode("Object.freeze = () => { while (true) {} };");

      expect(prepared.error).toBeUndefined();

      return installLocalToolBridge(vm, {}, scope);
    },
    interruptFlag(),
  );

  expect(result).toEqual({
    ok: false,
    error: { kind: "timeout", message: "Execution exceeded the 100 ms limit." },
  });
  expectDisposedExecution(resources);
});

test("preserves timeout classification while encoding a thrown string", async () => {
  const resources: ExecutionResources[] = [];

  const result = await executeEngine(
    'throw "Guest error";',
    { ...DEFAULT_LIMITS, timeoutMs: 100 },
    (vm, scope) => {
      resources.push({ vm, scope });
      // Hold the captured encoder in guest computation until the real deadline.
      using prepared = vm.evalCode("JSON.stringify = () => { while (true) {} };");

      expect(prepared.error).toBeUndefined();

      return installLocalToolBridge(vm, {}, scope);
    },
    interruptFlag(),
  );

  expect(result).toEqual({
    ok: false,
    error: { kind: "timeout", message: "Execution exceeded the 100 ms limit." },
  });
  expectDisposedExecution(resources);
});

for (const scenario of [
  {
    name: "successful execution",
    code: "return await tools.read();",
    expected: { ok: true, value: 42 },
  },
  {
    name: "script rejection",
    code: 'await tools.read(); throw new Error("Script failed");',
    expected: { ok: false, error: { kind: "script", message: "Script failed" } },
  },
  {
    name: "timeout with a pending call",
    code: "tools.read(); while (true) {}",
    expected: {
      ok: false,
      error: { kind: "timeout", message: "Execution exceeded the 100 ms limit." },
    },
  },
  {
    name: "output rejection",
    code: 'await tools.read(); return "x".repeat(100);',
    expected: {
      ok: false,
      error: {
        kind: "limit",
        resource: "output",
        maximum: 64,
        message: "Output exceeds the 64 byte limit.",
      },
    },
  },
] satisfies { name: string; code: string; expected: SandboxResult }[]) {
  test(`disposes the VM, runtime, and native bridge handles after ${scenario.name}`, async () => {
    const resources: ExecutionResources[] = [];
    const handles: QuickJSHandle[] = [];
    const settlements: QuickJSHandle[] = [];
    using cleanup = new DisposableStack();

    const result = await executeEngine(
      scenario.code,
      { ...DEFAULT_LIMITS, timeoutMs: 100, maxOutputBytes: 64 },
      (vm, scope) => {
        resources.push({ vm, scope });
        const getProp = vm.getProp.bind(vm);

        // Only the dispatcher and settlement function need execution-long native handles.
        const settlement = spyOn(vm, "getProp").mockImplementation(
          (...args: Parameters<typeof vm.getProp>) => {
            const handle = getProp(...args);
            if (args[1] === "settle") settlements.push(handle);

            return handle;
          },
        );

        cleanup.defer(() => settlement.mockRestore());

        const bridge = installLocalToolBridge(vm, { read: () => ToolResult.success(42) }, scope, {
          maxToolCalls: 1,
          maxConcurrentToolCalls: 1,
        });

        handles.push(bridge.dispatcher);

        return bridge;
      },
      interruptFlag(),
    );

    expect(result).toEqual(scenario.expected);
    expectDisposedExecution(resources);
    expect(handles.length).toBeGreaterThan(0);
    expect(settlements.length).toBeGreaterThan(0);
    for (const handle of [...handles, ...settlements]) {
      expect(handle.alive).toBe(false);
    }
  });
}

test("preserves setup and disposal failures without retrying cleanup", async () => {
  const quickJS = await getQuickJS();
  const vm = quickJS.newContext();
  const dispose = vm.dispose.bind(vm);
  using cleanup = new DisposableStack();
  cleanup.defer(() => {
    if (vm.alive) dispose();
  });
  const setupFailure = new Error("Stack configuration failed");
  const cleanupFailure = new Error("Context disposal failed");
  using context = spyOn(quickJS, "newContext").mockReturnValue(vm);

  using stack = spyOn(vm.runtime, "setMaxStackSize").mockImplementation(() => {
    throw setupFailure;
  });

  using disposal = spyOn(vm, "dispose").mockImplementation(() => {
    dispose();
    throw cleanupFailure;
  });

  const rejected = await rejectionOf(createVm());

  expect(rejected.reason).toBeInstanceOf(SuppressedError);
  if (!(rejected.reason instanceof SuppressedError)) throw new Error("Expected both failures.");

  expect(rejected.reason.error).toBe(cleanupFailure);
  expect(rejected.reason.suppressed).toBe(setupFailure);
  expect(context).toHaveBeenCalledTimes(1);
  expect(stack).toHaveBeenCalledTimes(1);
  expect(disposal).toHaveBeenCalledTimes(1);
  expect(vm.alive).toBe(false);
  expect(vm.runtime.alive).toBe(false);
});

test("disposes partially configured VM resources and preserves the setup cause", async () => {
  const quickJS = await getQuickJS();
  const vm = quickJS.newContext();
  using cleanup = new DisposableStack();
  cleanup.defer(() => {
    if (vm.alive) vm.dispose();
  });
  const failure = new Error("Stack configuration failed");
  using context = spyOn(quickJS, "newContext").mockReturnValue(vm);

  using stack = spyOn(vm.runtime, "setMaxStackSize").mockImplementation(() => {
    throw failure;
  });

  expect((await rejectionOf(createVm())).reason).toBe(failure);
  expect(context).toHaveBeenCalledTimes(1);
  expect(stack).toHaveBeenCalledTimes(1);
  expect(vm.alive).toBe(false);
  expect(vm.runtime.alive).toBe(false);
});
