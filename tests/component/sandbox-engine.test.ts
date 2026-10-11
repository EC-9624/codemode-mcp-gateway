import { expect, spyOn, test } from "bun:test";
import { type QuickJSDeferredPromise } from "quickjs-emscripten";
import { Parser } from "acorn";
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
  expect(await execute("return 3;")).toEqual({ ok: true, value: 3 });
});

test("shared interruption disposes the VM, runtime, and bridge scope", async () => {
  const resources: ExecutionResources[] = [];
  const interrupt = new Int32Array(new SharedArrayBuffer(4));

  expect(
    await executeEngine(
      "tools.read(); while (true) {}",
      1000,
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

    const result = await executeEngine(scenario.code, 100, (vm, scope) => {
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
    });

    expect(result).toEqual(scenario.expected);
    expectDisposedExecution(resources);
    expect(promises).toHaveLength(1);
    for (const promise of promises) {
      expect(promise.alive).toBe(false);
      expect(promise.handle.alive).toBe(false);
    }
  });
}
