import { type ToolCatalog, type ToolDefinition } from "@codemode-mcp-gateway/codemode";

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
