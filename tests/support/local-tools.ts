import { type QuickJSContext, type Scope } from "quickjs-emscripten";
import { DEFAULT_LIMITS } from "../../src/codemode/runtime/limits";
import { executeEngine } from "../../src/codemode/runtime/engine";
import { callTool, serializeToolResult, type SandboxTool } from "../../src/codemode/tools";
import { installGuestToolBridge } from "../../src/codemode/runtime/guest-bridge";
import { type ToolCallLimits } from "../../src/codemode/runtime/budget";
import { interruptFlag } from "./workers";

export function executeLocally(
  code: string,
  tools: Readonly<Record<string, SandboxTool>> = {},
  timeoutMs = 1000,
  limits: ToolCallLimits = DEFAULT_LIMITS,
) {
  return executeEngine(
    code,
    { ...DEFAULT_LIMITS, timeoutMs },
    (vm, scope) => installLocalToolBridge(vm, tools, scope, limits),
    interruptFlag(),
  );
}

/** Worker transport would hide the VM handles and original exceptions these tests inspect. */
export function installLocalToolBridge(
  vm: QuickJSContext,
  tools: Readonly<Record<string, SandboxTool>>,
  scope: Scope,
  limits: ToolCallLimits = DEFAULT_LIMITS,
) {
  const registry = new Map(Object.entries(tools));
  const context = { signal: new AbortController().signal };

  return installGuestToolBridge(
    vm,
    [...registry.keys()],
    async (name, json) => {
      const tool = registry.get(name);
      if (!tool) throw new Error("Test bridge referenced an unknown tool.");

      const args: unknown = json === undefined ? undefined : JSON.parse(json);

      return serializeToolResult(await callTool(tool, args, context));
    },
    scope,
    limits,
  );
}
