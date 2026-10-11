import { expect, spyOn, test } from "bun:test";
import { type QuickJSDeferredPromise } from "quickjs-emscripten";
import { Parser } from "acorn";
import { DEFAULT_LIMITS } from "../../src/execution-limits";
import { execute, ToolResult, type SandboxResult } from "../../src/sandbox";
import { executeEngine } from "../../src/sandbox-engine";
import { expectDisposedExecution, type ExecutionResources } from "../support/disposal";
import { executeLocally, installLocalToolBridge } from "../support/local-tools";
import { rejectionOf } from "../support/rejection";

test("propagates unexpected parser failures instead of reporting a script error", async () => {
  const failure = new Error("Parser infrastructure failed");

  using parser = spyOn(Parser, "parse").mockImplementation(() => {
    throw failure;
  });

  const result = await rejectionOf(executeLocally("return 3;"));

  expect(result.reason).toBe(failure);
  expect(parser).toHaveBeenCalledTimes(1);

  parser.mockRestore();
  expect((await execute("return 3;")).result).toEqual({ ok: true, value: 3 });
});

test("shared interruption disposes the VM, runtime, and bridge scope", async () => {
  const resources: ExecutionResources[] = [];
  const interrupt = new Int32Array(new SharedArrayBuffer(4));

  expect(
    await executeEngine(
      "tools.read(); while (true) {}",
      { ...DEFAULT_LIMITS, timeoutMs: 1000 },
      (vm, scope) => {
        resources.push({ vm, scope });

        return installLocalToolBridge(
          vm,
          {
            read: () => {
              Atomics.store(interrupt, 0, 1);

              return ToolResult.success(42);
            },
          },
          scope,
        );
      },
      interrupt,
    ),
  ).toEqual({
    ok: false,
    error: { kind: "timeout", message: "Execution interrupted by the parent." },
  });
  expectDisposedExecution(resources);
});

test("preserves parent interruption during guest error conversion", async () => {
  const resources: ExecutionResources[] = [];
  const interrupt = new Int32Array(new SharedArrayBuffer(4));

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

test.each([
  ["memory", { memoryLimitBytes: 1 }],
  ["stack", { maxStackSizeBytes: 1024 }],
] as const)(
  "disposes execution resources after %s-limited prelude compilation fails",
  async (_name, limits) => {
    const resources: ExecutionResources[] = [];

    const failure = await rejectionOf(
      executeEngine(
        "return 42;",
        { ...DEFAULT_LIMITS, ...limits, timeoutMs: 1000 },
        (vm, scope) => {
          resources.push({ vm, scope });

          return installLocalToolBridge(vm, {}, scope);
        },
      ),
    );

    expect(failure.reason).toBeInstanceOf(Error);
    if (failure.reason instanceof Error) {
      expect(failure.reason.message).toBe("Sandbox prelude initialization failed.");
    }

    expectDisposedExecution(resources);
  },
);

test("rejects prelude factory invocation failure and disposes execution resources", async () => {
  const resources: ExecutionResources[] = [];

  const failure = await rejectionOf(
    executeEngine("return 42;", { ...DEFAULT_LIMITS, timeoutMs: 1000 }, (vm, scope) => {
      resources.push({ vm, scope });

      // Fail a prelude dependency after compilation, before submitted code runs.
      using prepared = vm.evalCode(
        'Object.keys = () => { throw new Error("Private prelude failure"); };',
      );

      expect(prepared.error).toBeUndefined();

      return installLocalToolBridge(vm, {}, scope);
    }),
  );

  expect(failure.reason).toBeInstanceOf(Error);
  if (failure.reason instanceof Error) {
    expect(failure.reason.message).toBe("Sandbox prelude initialization failed.");
  }

  expectDisposedExecution(resources);
});

test.each([
  ["return value", 'await tools.read(); return "x".repeat(40);'],
  ["error message", 'await tools.read(); throw new Error("x".repeat(40));'],
] as const)("disposes execution resources after an oversized %s", async (_name, code) => {
  const resources: ExecutionResources[] = [];

  const result = await executeEngine(
    code,
    { ...DEFAULT_LIMITS, timeoutMs: 1000, maxOutputBytes: 32 },
    (vm, scope) => {
      resources.push({ vm, scope });

      return installLocalToolBridge(vm, { read: () => ToolResult.success(42) }, scope);
    },
  );

  expect(result).toEqual({
    ok: false,
    error: {
      kind: "limit",
      resource: "output",
      maximum: 32,
      message: "Output exceeds the 32 byte limit.",
    },
  });
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
      using prepared = vm.evalCode("Object.keys = () => { while (true) {} };");

      expect(prepared.error).toBeUndefined();

      return installLocalToolBridge(vm, {}, scope);
    },
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
] satisfies { name: string; code: string; expected: SandboxResult }[]) {
  test(`disposes the VM, runtime, bridge scope, and tool promises after ${scenario.name}`, async () => {
    const resources: ExecutionResources[] = [];
    const promises: QuickJSDeferredPromise[] = [];
    using cleanup = new DisposableStack();

    const result = await executeEngine(
      scenario.code,
      { ...DEFAULT_LIMITS, timeoutMs: 100 },
      (vm, scope) => {
        resources.push({ vm, scope });
        const newPromise = vm.newPromise.bind(vm);

        // Observe real deferred handles; results alone cannot prove their disposal.
        const created = spyOn(vm, "newPromise").mockImplementation(() => {
          const promise = newPromise();
          promises.push(promise);

          return promise;
        });

        cleanup.defer(() => created.mockRestore());

        return installLocalToolBridge(vm, { read: () => ToolResult.success(42) }, scope);
      },
    );

    expect(result).toEqual(scenario.expected);
    expectDisposedExecution(resources);
    expect(promises).toHaveLength(1);
    for (const promise of promises) {
      expect(promise.alive).toBe(false);
      expect(promise.handle.alive).toBe(false);
    }
  });
}
