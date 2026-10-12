import { type QuickJSContext, type Scope } from "quickjs-emscripten";
import { DEFAULT_LIMITS } from "../../src/codemode/runtime/limits";
import { executeEngine } from "../../src/codemode/runtime/engine";
import { callTool, serializeToolResult, type SandboxTool } from "../../src/codemode/tools";
import { installGuestToolBridge, type ToolBridge } from "../../src/codemode/runtime/guest-bridge";
import { type ToolCallLimits } from "../../src/codemode/runtime/budget";
import { interruptFlag } from "./workers";
import { prepareRunner } from "../../src/codemode/runtime/script";

/** Direct bridge tests need the real prelude; engine tests initialize it themselves. */
export function prepareTools(vm: QuickJSContext, bridge: ToolBridge): void {
  using api = prepareRunner(vm, bridge.dispatcher, bridge.toolNames).unwrap();
  bridge.attach(api);
}

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

  const bridge = installGuestToolBridge(
    vm,
    [...registry.keys()],
    (call) => {
      const tool = registry.get(call.name);
      if (!tool) throw new Error("Test bridge referenced an unknown tool.");

      const args: unknown = call.argsJson === null ? undefined : JSON.parse(call.argsJson);
      void callTool(tool, args, context)
        .then((result) => {
          if (!scope.alive) return;

          bridge.receive({
            type: "tool-result",
            callId: call.callId,
            result: serializeToolResult(result),
          });
        })
        .catch((error: unknown) => bridge.fail(error));
    },
    scope,
    limits,
  );

  return bridge;
}
