import { getQuickJS, type QuickJSContext } from "quickjs-emscripten";

const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const STACK_LIMIT_BYTES = 1024 * 1024;

/** Create a fresh context that owns its runtime; the caller owns disposal. */
export async function createVm(): Promise<QuickJSContext> {
  const quickJS = await getQuickJS();
  const vm = quickJS.newContext();
  try {
    vm.runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
    vm.runtime.setMaxStackSize(STACK_LIMIT_BYTES);

    return vm;
  } catch (error) {
    // Factory-local `using` would dispose the VM before ownership reaches the caller.
    vm.dispose();
    throw error;
  }
}
