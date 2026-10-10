import { type SandboxResult } from "./sandbox-result";
import { type SandboxTool } from "./tool";
import { runSandbox } from "./worker-execution";

export { type SandboxResult } from "./sandbox-result";
export { ToolResult, type SandboxTool } from "./tool";

/** Execute a JavaScript async function body in a fresh worker with host-owned tools. */
export async function execute(
  code: string,
  tools: Readonly<Record<string, SandboxTool>> = {},
): Promise<SandboxResult> {
  return await runSandbox(code, tools);
}
