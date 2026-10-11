import { getQuickJS, type QuickJSContext } from "quickjs-emscripten";
import { DEFAULT_LIMITS, type ExecutionLimits } from "./execution-limits";

export type VmLimits = Pick<ExecutionLimits, "memoryLimitBytes" | "maxStackSizeBytes">;

/** Create a fresh context that owns its runtime; the caller owns disposal. */
export async function createVm(limits: VmLimits = DEFAULT_LIMITS): Promise<QuickJSContext> {
  const quickJS = await getQuickJS();
  const vm = quickJS.newContext();
  try {
    vm.runtime.setMemoryLimit(limits.memoryLimitBytes);
    vm.runtime.setMaxStackSize(limits.maxStackSizeBytes);

    return vm;
  } catch (error) {
    // Factory-local `using` would dispose the VM before ownership reaches the caller.
    vm.dispose();
    throw error;
  }
}
