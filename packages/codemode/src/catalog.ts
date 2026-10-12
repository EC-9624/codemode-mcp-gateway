import { type StandardJSONSchemaV1, type StandardSchemaV1 } from "@standard-schema/spec";
import {
  ToolResult,
  validateTool,
  type SandboxTool,
  type ToolContext,
  type ToolSchema,
} from "./tools.js";

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

export type ToolCatalog = {
  readonly tools: Readonly<Record<string, SandboxTool>>;
  /** Rank case-insensitive name/description matches by distinct query terms; ties keep catalog order. */
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
            const text = `${tool.name} ${tool.description}`.toLowerCase();

            return { tool, score: terms.filter((term) => text.includes(term)).length };
          })
          .filter((match) => match.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((match) => match.tool);
      },
      describe(name) {
        return descriptions.get(name);
      },
    };
  },
};

/** The app chooses names when exposing these callbacks, so catalog tool names are never reserved. */
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

      return ToolResult.success(catalog.search(args.query));
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
