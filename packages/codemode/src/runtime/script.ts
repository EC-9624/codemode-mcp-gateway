import { parse } from "acorn";
import { type QuickJSContext, type QuickJSHandle } from "quickjs-emscripten";
import { PRELUDE_SOURCE } from "./prelude.ts";

export function prepareScript(
  code: string,
): { ok: true; source: string } | { ok: false; message: string } {
  const prefix = '(async (tools) => {\n"use strict";\n';
  const source = `${prefix}${code}\n})`;
  let program: ReturnType<typeof parse>;
  try {
    // Restricting body syntax would reject valid JavaScript; only wrapper escapes are forbidden.
    program = parse(source, { ecmaVersion: "latest", sourceType: "script" });
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;

    return { ok: false, message: error.message };
  }

  const statement = program.body[0];
  if (
    program.body.length !== 1 ||
    statement?.type !== "ExpressionStatement" ||
    statement.expression.type !== "ArrowFunctionExpression" ||
    !statement.expression.async ||
    statement.expression.body.type !== "BlockStatement" ||
    statement.expression.body.start !== prefix.indexOf("{") ||
    statement.expression.body.end !== source.length - 1
  ) {
    return { ok: false, message: "Source must stay inside the submitted async function body." };
  }

  return { ok: true, source };
}

/** Borrows the dispatcher; the caller owns the private prelude API or error handle. */
export function prepareRunner(
  vm: QuickJSContext,
  dispatcher: QuickJSHandle,
  toolNames: readonly string[],
) {
  // Disposing an error result here would invalidate the handle the caller must inspect.
  const factory = vm.evalCode(PRELUDE_SOURCE, "sandbox-prelude.js");
  if (factory.error) return factory;

  using factoryHandle = factory.value;
  using names = vm.newString(JSON.stringify(toolNames));

  return vm.callFunction(factoryHandle, vm.undefined, dispatcher, names);
}

/** Borrows the runner; the caller owns the returned promise or error handle. */
export function startScript(vm: QuickJSContext, source: string, runner: QuickJSHandle) {
  const compiled = vm.evalCode(source, "sandbox.js");
  if (compiled.error) return compiled;

  using script = compiled.value;

  return vm.callFunction(runner, vm.undefined, script);
}
