import {
  ProtocolError,
  type CallToolResult,
  type Client,
  type Tool,
} from "@modelcontextprotocol/client";
import { ToolResult, validateTool, ToolCatalog, type ToolDefinition } from "@cmg/codemode";
import { compileToolSchema } from "./schema.ts";
import { type McpCatalogOptions } from "./types.ts";

// Codemode keeps its equivalent constant internal; MCP depends only on its public API.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Discover a catalog snapshot from a connected, application-owned MCP client.
 * Refresh the listing and compile each input schema once. Missing tools capability returns
 * an empty catalog; invalid options, duplicate names, and invalid schemas reject setup.
 * The caller owns the client on every exit, and must keep it connected for later tool calls.
 *
 * Discovery options do not carry into invocation: calls use the execution's signal.
 * MCP isError responses remain data. Protocol errors expose their code/message, not data or stacks;
 * other invocation exceptions use the sandbox's private boundary.
 */
export async function createMcpCatalog(
  client: Client,
  options: McpCatalogOptions = {},
): Promise<ToolCatalog> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}.`);
  }

  const signal = options.signal;
  signal?.throwIfAborted();
  const capabilities = client.getServerCapabilities();
  if (client.transport === undefined || capabilities === undefined) {
    throw new Error("Connect the MCP client before discovering tools.");
  }

  if (capabilities.tools === undefined) return ToolCatalog.create({});

  using cleanup = new DisposableStack();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  cleanup.defer(() => signal?.removeEventListener("abort", abort));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();

  const expiresAt = performance.now() + timeoutMs;

  const expire = () => {
    controller.abort(new Error(`MCP tool discovery exceeded the ${timeoutMs} ms limit.`));
  };

  const timer = setTimeout(expire, timeoutMs);

  cleanup.defer(() => clearTimeout(timer));

  // The SDK aggregates pages and populates its output-schema cache. Refresh bypasses stale listings.
  const listing = await client.listTools(undefined, {
    signal: controller.signal,
    cacheMode: "refresh",
  });

  controller.signal.throwIfAborted();
  const names = new Set<string>();
  for (const tool of listing.tools) {
    if (names.has(tool.name)) {
      throw new Error(`MCP tool discovery returned duplicate name ${JSON.stringify(tool.name)}.`);
    }

    names.add(tool.name);
  }

  const catalog = ToolCatalog.create(
    Object.fromEntries(listing.tools.map((tool) => [tool.name, createMcpTool(client, tool)])),
  );

  // Synchronous compilation can outlast the timer before the event loop gets another turn.
  if (performance.now() >= expiresAt) expire();

  controller.signal.throwIfAborted();

  return catalog;
}

function createMcpTool(client: Client, tool: Tool): ToolDefinition {
  const compiled = compileToolSchema(tool.inputSchema);
  if (!compiled.ok) {
    throw new Error(
      `Invalid input schema for tool ${JSON.stringify(tool.name)}: ${compiled.message}`,
      { cause: compiled.cause },
    );
  }

  const invoke = validateTool(
    compiled.validator,
    async (args, { signal }) => {
      // Normalization precedes validation; the JSON validator preserves arguments unchanged.
      if (!isArguments(args)) throw new Error("MCP argument normalization failed.");

      let response: CallToolResult;
      try {
        response = await client.callTool({ name: tool.name, arguments: args }, { signal });
      } catch (cause) {
        // The SDK also uses ProtocolError for local output validation. Both messages are public.
        if (cause instanceof ProtocolError) {
          return ToolResult.failure(
            `MCP tool ${JSON.stringify(tool.name)} failed (code ${cause.code}): ${cause.message}`,
            { cause },
          );
        }

        throw cause;
      }

      return ToolResult.success({
        content: response.content,
        ...(response.structuredContent === undefined
          ? {}
          : { structuredContent: response.structuredContent }),
        ...(response.isError === undefined ? {} : { isError: response.isError }),
      });
    },
    tool.name,
  );

  return {
    description: tool.description ?? `MCP tool: ${tool.name}`,
    inputSchema: compiled.schema,
    execute(args, context) {
      if (args !== undefined && !isArguments(args)) {
        return ToolResult.failure("MCP tool arguments must be an object.");
      }

      return invoke(args ?? {}, context);
    },
  };
}

function isArguments(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
