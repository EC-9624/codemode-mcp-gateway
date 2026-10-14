import { getQuickJS, type QuickJSContext } from "quickjs-emscripten";
import { DEFAULT_LIMITS, type ExecutionLimits } from "./limits.ts";

type VmLimits = Pick<ExecutionLimits, "memoryLimitBytes" | "maxStackSizeBytes">;

/** Create a fresh context that owns its runtime; the caller owns disposal. */
export async function createVm(limits: VmLimits = DEFAULT_LIMITS): Promise<QuickJSContext> {
  const quickJS = await getQuickJS();
  using cleanup = new DisposableStack();
  const vm = cleanup.use(quickJS.newContext());
  vm.runtime.setMemoryLimit(limits.memoryLimitBytes);
  vm.runtime.setMaxStackSize(limits.maxStackSizeBytes);

  // `move()` empties the scoped stack so returning does not dispose the caller-owned VM.
  // Before this transfer, configuration failures dispose the VM and preserve cleanup errors.
  cleanup.move();

  return vm;
}
