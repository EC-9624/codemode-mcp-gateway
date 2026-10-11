import { type QuickJSContext, type Scope } from "quickjs-emscripten";
import { DEFAULT_LIMITS } from "../../src/execution-limits";
import { executeEngine } from "../../src/sandbox-engine";
import { callTool, serializeToolResult, type SandboxTool } from "../../src/tool";
import { installGuestToolBridge } from "../../src/guest-tool-bridge";

export function executeLocally(
  code: string,
  tools: Readonly<Record<string, SandboxTool>> = {},
  timeoutMs = 1000,
) {
  return executeEngine(code, { ...DEFAULT_LIMITS, timeoutMs }, (vm, scope) =>
    installLocalToolBridge(vm, tools, scope),
  );
}

/** Worker transport would hide the VM handles and original exceptions these tests inspect. */
export function installLocalToolBridge(
  vm: QuickJSContext,
  tools: Readonly<Record<string, SandboxTool>>,
  scope: Scope,
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
  );
}
