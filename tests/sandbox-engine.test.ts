import { expect, spyOn, test } from "bun:test";
import { type QuickJSContext, type QuickJSDeferredPromise, type Scope } from "quickjs-emscripten";
import { ToolResult, type SandboxResult } from "../src/sandbox";
import { executeEngine } from "../src/sandbox-engine";
import { installLocalTools } from "./local-tools";

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
      error: { kind: "timeout", message: "Execution exceeded the 1-second limit." },
    },
  },
] satisfies { name: string; code: string; expected: SandboxResult }[]) {
  test(`disposes the VM, runtime, bridge scope, and tool promises after ${scenario.name}`, async () => {
    const resources: { vm: QuickJSContext; scope: Scope }[] = [];
    const promises: QuickJSDeferredPromise[] = [];
    using cleanup = new DisposableStack();
    const result = await executeEngine(scenario.code, (vm, scope) => {
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
    expect(resources).toHaveLength(1);
    expect(promises).toHaveLength(1);
    for (const { vm, scope } of resources) {
      expect(scope.alive).toBe(false);
      expect(vm.alive).toBe(false);
      expect(vm.runtime.alive).toBe(false);
    }
    for (const promise of promises) {
      expect(promise.alive).toBe(false);
      expect(promise.handle.alive).toBe(false);
    }
  });
}
