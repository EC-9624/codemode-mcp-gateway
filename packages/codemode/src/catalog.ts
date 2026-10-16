import { type StandardJSONSchemaV1, type StandardSchemaV1 } from "@standard-schema/spec";
import {
  ToolResult,
  validateTool,
  type SandboxTool,
  type ToolContext,
  type ToolSchema,
} from "./tools.ts";

export type ToolDefinition = {
  description: string;
  /** Discovery metadata. defineTool binds a native validator to the callback. */
  inputSchema?: ToolSchema;
  execute: SandboxTool;
};

/** Native schemas validate values and export the input contract used by discovery. */
export type ToolInputSchema<Input = unknown, Output = Input> = StandardSchemaV1<Input, Output> &
  StandardJSONSchemaV1<Input, Output>;

/**
 * Build a tool whose handler receives the schema's validated output, including transforms.
 * Export and copy input JSON Schema once for discovery; the native schema validates calls.
 * JSON Schema export/copy failures throw during definition, before any execution.
 */
export function defineTool<Input, Output>(definition: {
  description: string;
  inputSchema: ToolInputSchema<Input, Output>;
  execute: (args: Output, context: ToolContext) => ToolResult | Promise<ToolResult>;
}): ToolDefinition {
  const schema = definition.inputSchema;

  const inputSchema = structuredClone(
    schema["~standard"].jsonSchema.input({ target: "draft-2020-12" }),
  );

  return {
    description: definition.description,
    inputSchema,
    execute: validateTool(schema, definition.execute),
  };
}

export type ToolDescription = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: ToolSchema;
};

/** Compact discovery page; use describeTool for complete descriptions and input schemas. */
export type ToolSearchPage = {
  readonly tools: readonly Pick<ToolDescription, "name" | "description">[];
  readonly total: number;
  readonly nextOffset: number | null;
};

export type ToolCatalog = {
  readonly tools: Readonly<Record<string, SandboxTool>>;
  /** Rank by distinct query terms found in names, then names/descriptions; case-insensitive, stable ties. */
  search(query: string): ToolDescription[];
  /** Exact-name lookup; unknown names return undefined without invoking a tool. */
  describe(name: string): ToolDescription | undefined;
};

export const ToolCatalog = {
  /**
   * Snapshot callback bindings, names, and descriptions; schemas are metadata, not validators.
   * Schema objects remain shared references and must be treated as read-only.
   */
  create(definitions: Readonly<Record<string, ToolDefinition>>): ToolCatalog {
    const entries = Object.entries(definitions);

    const tools = Object.freeze(
      Object.fromEntries(entries.map(([name, tool]) => [name, tool.execute])),
    );

    // Selecting metadata fields avoids exposing callbacks or private extension fields in discovery.
    const descriptions = new Map(
      entries.map(([name, tool]) => [
        name,
        Object.freeze({
          name,
          description: tool.description,
          ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
        }),
      ]),
    );

    return {
      tools,
      search(query) {
        const terms = [
          ...new Set(
            query
              .toLowerCase()
              .trim()
              .split(/\s+/u)
              .filter((term) => term.length > 0),
          ),
        ];

        return [...descriptions.values()]
          .map((tool) => {
            const name = tool.name.toLowerCase();
            const text = `${name} ${tool.description.toLowerCase()}`;

            return {
              tool,
              nameScore: terms.filter((term) => name.includes(term)).length,
              score: terms.filter((term) => text.includes(term)).length,
            };
          })
          .filter((match) => match.score > 0)
          .sort((a, b) => b.nameScore - a.nameScore || b.score - a.score)
          .map((match) => match.tool);
      },
      describe(name) {
        return descriptions.get(name);
      },
    };
  },
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
