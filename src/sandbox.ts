import { getQuickJS } from "quickjs-emscripten";

const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const STACK_LIMIT_BYTES = 1024 * 1024;
const TIMEOUT_MS = 1000;

export type SandboxResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { kind: "script" | "timeout"; message: string } };

/** Execute a synchronous JavaScript function body in a fresh QuickJS runtime. */
export async function execute(code: string): Promise<SandboxResult> {
  const quickJS = await getQuickJS();
  using runtime = quickJS.newRuntime();
  runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(STACK_LIMIT_BYTES);
  const deadline = performance.now() + TIMEOUT_MS;
  runtime.setInterruptHandler(() => performance.now() >= deadline);

  // `using` disposes in reverse declaration order: result, context, runtime.
  using context = runtime.newContext();
  using evaluated = context.evalCode(buildScript(code), "sandbox.js");

  if (evaluated.error) {
    if (performance.now() >= deadline) {
      return {
        ok: false,
        error: { kind: "timeout", message: "Execution exceeded the 1-second computation limit." },
      };
    }

    const error: unknown = context.dump(evaluated.error);
    return { ok: false, error: { kind: "script", message: scriptErrorMessage(error) } };
  }

  const value: unknown = JSON.parse(context.getString(evaluated.value));
  return { ok: true, value };
}

function buildScript(code: string): string {
  // Serialize inside the VM: guest objects must not become host objects with
  // executable getters or methods. Capture stringify before running the script.
  return `(() => {
    "use strict";
    const stringify = JSON.stringify;
    const ResultError = TypeError;
    const value = (() => {
${code}
    })();

    const isObject = typeof value === "object" && value !== null;
    const isFunction = typeof value === "function";
    const canHaveProperties = isObject || isFunction;
    if (canHaveProperties && typeof value.then === "function") {
      throw new ResultError("Async results are not supported yet. Return a synchronous value.");
    }

    const json = stringify(value);
    if (json === undefined && value !== undefined) {
      throw new ResultError("Return value is not JSON-serializable.");
    }
    return json ?? "null";
  })()`;
}

function scriptErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  return "Script threw a value without an error message.";
}
