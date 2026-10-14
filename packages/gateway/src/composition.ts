import {
  CodeExecutor,
  createDiscoveryTools,
  type SandboxOptions,
  type ToolCatalog,
} from "@cmg/codemode";
import { createCodemodeServer } from "@cmg/mcp";
import { GatewayError } from "./errors.ts";

/**
 * Create a fixed-policy QuickJS executor with local discovery and expose it over MCP.
 * Helper-name collisions and invalid sandbox policy throw before a server is returned.
 * The caller owns the MCP transport and the catalog's external resources; server.close()
 * aborts this server's requests and awaits their execution cleanup.
 */
export function createServer(catalog: ToolCatalog, options: Omit<SandboxOptions, "tools"> = {}) {
  const discovery = createDiscoveryTools(catalog);
  for (const name of Object.keys(discovery)) {
    if (Object.hasOwn(catalog.tools, name)) {
      throw new GatewayError(
        `Upstream tool ${JSON.stringify(name)} conflicts with a CMG discovery helper.`,
      );
    }
  }

  const executor = new CodeExecutor({ ...options, tools: { ...catalog.tools, ...discovery } });

  return createCodemodeServer({
    execute: (code, options) => executor.execute(code, options),
    description: `Run JavaScript as an async function body in a fresh QuickJS sandbox.
Start with: return await tools.searchTools({ query: "what you need" });
Search returns exact tool names, descriptions, and input schemas. Inspect one with
tools.describeTool({ name }). Call it with await tools["exact-name"](args).
Upstream MCP tools resolve to { content, structuredContent?, isError? }; check isError.
Use JavaScript to chain calls, run independent calls concurrently, and filter results.
Return the JSON value you want to see. No fetch, filesystem, process, or imports are available.
Resource limits are server-owned. The response includes the result and compact call summaries;
completed calls are observations, not a guarantee of external success or safe retry.`,
  });
}
