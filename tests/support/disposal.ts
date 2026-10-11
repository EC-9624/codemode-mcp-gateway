import { expect } from "bun:test";
import { type QuickJSContext, type Scope } from "quickjs-emscripten";

export type ExecutionResources = { vm: QuickJSContext; scope: Scope };

/** Asserts that exactly one execution ran and released its VM, runtime, and bridge scope. */
export function expectDisposedExecution(resources: readonly ExecutionResources[]) {
  expect(resources).toHaveLength(1);
  for (const { vm, scope } of resources) {
    expect(vm.alive).toBe(false);
    expect(vm.runtime.alive).toBe(false);
    expect(scope.alive).toBe(false);
  }
}
