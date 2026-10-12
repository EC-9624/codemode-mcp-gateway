import { getQuickJS, type QuickJSContext } from "quickjs-emscripten";
import { DEFAULT_LIMITS, type ExecutionLimits } from "./limits.js";

type VmLimits = Pick<ExecutionLimits, "memoryLimitBytes" | "maxStackSizeBytes">;

/** Create a fresh context that owns its runtime; the caller owns disposal. */
export async function createVm(limits: VmLimits = DEFAULT_LIMITS): Promise<QuickJSContext> {
  const quickJS = await getQuickJS();
  using cleanup = new DisposableStack();
  const vm = cleanup.use(quickJS.newContext());
  vm.runtime.setMemoryLimit(limits.memoryLimitBytes);
  vm.runtime.setMaxStackSize(limits.maxStackSizeBytes);

  // Transfer ownership only after configuration succeeds; failed cleanup preserves both errors.
  cleanup.move();

  return vm;
}
