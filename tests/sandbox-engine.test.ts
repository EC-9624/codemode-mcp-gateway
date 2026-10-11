import { expect, spyOn, test } from "bun:test";
import { type QuickJSDeferredPromise } from "quickjs-emscripten";
import { ToolResult, type SandboxResult } from "../src/sandbox";
import { executeEngine } from "../src/sandbox-engine";
import { expectDisposedExecution, type ExecutionResources } from "./disposal";
import { installLocalTools } from "./local-tools";

test("shared interruption disposes the VM, runtime, and bridge scope", async () => {
  const resources: ExecutionResources[] = [];
  const interrupt = new Int32Array(new SharedArrayBuffer(4));

  expect(
    await executeEngine(
      "tools.read(); while (true) {}",
      1000,
      (vm, scope) => {
        resources.push({ vm, scope });

        return installLocalTools(
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

      return installLocalTools(vm, { read: () => ToolResult.success(42) }, scope);
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
