import { type Client, type Tool } from "@modelcontextprotocol/client";
import { ToolResult, validateTool, ToolCatalog, type ToolDefinition } from "../codemode";
import { compileToolSchema } from "./schema";
import { type McpCatalogOptions } from "./types";

// Codemode keeps its equivalent constant internal; MCP depends only on its public API.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Discover a catalog snapshot from a connected, application-owned MCP client.
 * Setup failures reject on the host. The client remains owned by the caller on every exit.
 * MCP isError responses resolve as data; thrown invocation failures use callTool's private boundary.
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

      const response = await client.callTool({ name: tool.name, arguments: args }, { signal });

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
