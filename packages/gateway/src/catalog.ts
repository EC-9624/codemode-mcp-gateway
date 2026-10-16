import { type ToolCatalog, type ToolDefinition } from "@codemode-mcp-gateway/codemode";

/** Keep callable bindings and their discovery metadata together during adaptation. */
export function toolDefinitions(catalog: ToolCatalog): Array<[string, ToolDefinition]> {
  return Object.entries(catalog.tools).map(([name, execute]) => {
    const metadata = catalog.describe(name);
    if (metadata === undefined) throw new Error("Missing upstream catalog metadata.");

    return [name, { ...metadata, execute }];
  });
}
