import { type ToolCatalog, type ToolDescription } from "./catalog.ts";
import { ToolResult, type SandboxTool } from "./tools.ts";

/** Compact discovery page; use describeTool for complete descriptions and input schemas. */
export type ToolSearchPage = {
  readonly tools: readonly Pick<ToolDescription, "name" | "description">[];
  readonly total: number;
  readonly nextOffset: number | null;
};

/** Search returns five previews by default; offset/limit page all matches. The app chooses helper names. */
export function createDiscoveryTools(catalog: ToolCatalog) {
  return {
    searchTools: (args) => {
      if (
        typeof args !== "object" ||
        args === null ||
        !("query" in args) ||
        typeof args.query !== "string" ||
        args.query.trim() === ""
      ) {
        return ToolResult.failure("searchTools expects a non-empty query string in { query }.");
      }

      const limit = "limit" in args && args.limit !== undefined ? args.limit : 5;
      const offset = "offset" in args && args.offset !== undefined ? args.offset : 0;
      if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1) {
        return ToolResult.failure("searchTools limit must be a positive safe integer.");
      }

      if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
        return ToolResult.failure("searchTools offset must be a non-negative safe integer.");
      }

      const matches = catalog.search(args.query);

      const tools = matches.slice(offset, offset + limit).map((tool) => {
        const description = tool.description.replace(/\s+/gu, " ").trim();

        return {
          name: tool.name,
          // Truncation can split a UTF-16 surrogate pair; repair the preview before returning it.
          description:
            description.length > 200 ? description.slice(0, 199).toWellFormed() + "…" : description,
        };
      });

      const nextOffset = offset + tools.length;

      return ToolResult.success({
        tools,
        total: matches.length,
        nextOffset: nextOffset < matches.length ? nextOffset : null,
      } satisfies ToolSearchPage);
    },
    describeTool: (args) => {
      if (
        typeof args !== "object" ||
        args === null ||
        !("name" in args) ||
        typeof args.name !== "string"
      ) {
        return ToolResult.failure("describeTool expects a tool name string in { name }.");
      }

      const description = catalog.describe(args.name);
      if (!description) return ToolResult.failure("Tool not found in this catalog.");

      return ToolResult.success(description);
    },
  } satisfies Record<string, SandboxTool>;
}
