import {
  createDiscoveryTools,
  ToolResult,
  type SandboxTool,
  type ToolCatalog,
  type ToolDefinition,
} from "@codemode-mcp-gateway/codemode";
import { type ServerStatus } from "./server-status.ts";

/** Bind discovery to a fixed catalog/status revision; connection lifetimes stay with the gateway. */
export function discoveryBindings(
  catalog: ToolCatalog,
  statuses: readonly ServerStatus[],
): Readonly<Record<string, SandboxTool>> {
  const discovery = createDiscoveryTools(catalog);

  return {
    ...catalog.tools,
    ...discovery,
    searchTools: (args) => {
      let selected = discovery;
      let servers = statuses;
      if (
        typeof args === "object" &&
        args !== null &&
        "server" in args &&
        args.server !== undefined
      ) {
        if (typeof args.server !== "string")
          return ToolResult.failure("searchTools server must be a server name string.");

        const name = args.server;
        servers = statuses.filter((status) => status.name === name);
        if (servers.length === 0) return ToolResult.failure("Unknown server in this gateway.");

        // Filtering ranked matches before pagination preserves server-local offsets.
        selected = createDiscoveryTools({
          ...catalog,
          search: (query) =>
            catalog.search(query).filter((tool) => tool.name.startsWith(`${name}.`)),
        });
      }

      const result = selected.searchTools(args);
      if (!result.ok) return result;

      return ToolResult.success({ ...result.value, servers });
    },
  };
}

/**
 * Preserve descriptions and input schemas when the gateway namespaces or wraps
 * upstream tools, so discovery still describes the callable tools.
 */
export function toolDefinitions(catalog: ToolCatalog): Array<[string, ToolDefinition]> {
  return Object.entries(catalog.tools).map(([name, execute]) => {
    const metadata = catalog.describe(name);
    if (metadata === undefined) throw new Error("Missing upstream catalog metadata.");

    return [name, { ...metadata, execute }];
  });
}
