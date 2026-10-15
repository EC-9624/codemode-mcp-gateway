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
tools.searchTools({ query, limit?, offset? }) returns { tools, total, nextOffset },
with five ranked name/description previews by default, without schemas. nextOffset is null at the end.
tools.describeTool({ name }) returns the full description and inputSchema.
Call tools with await tools["name"](args). MCP results contain { content, structuredContent?, isError? }.
Compose calls, paginate, and transform results as needed. Return the JSON value to expose.
No fetch, filesystem, process, or imports are available. Resource limits are server-owned.
The response includes the final result and compact call summaries.`,
  });
}
