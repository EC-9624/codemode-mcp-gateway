import { type Client } from "@modelcontextprotocol/client";
import { ToolResult } from "./tool";
import { ToolCatalog, type ToolDefinition } from "./tool-catalog";
import { isTimeoutMs, MAX_TIMEOUT_MS } from "./worker-protocol";

export type McpCatalogOptions = {
  /** Overall tool discovery deadline in milliseconds. Defaults to 15000. */
  timeoutMs?: number;
  /** Cancels discovery only. Invocation uses the execution's ToolContext.signal. */
  signal?: AbortSignal;
};

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
  if (!isTimeoutMs(timeoutMs)) {
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

  const timer = setTimeout(() => {
    controller.abort(new Error(`MCP tool discovery exceeded the ${timeoutMs} ms limit.`));
  }, timeoutMs);

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

  return ToolCatalog.create(
    Object.fromEntries(
      listing.tools.map((tool) => [
        tool.name,
        {
          description: tool.description ?? `MCP tool: ${tool.name}`,
          inputSchema: tool.inputSchema,
          execute: async (args, { signal }) => {
            if (args !== undefined && !isArguments(args)) {
              return ToolResult.failure("MCP tool arguments must be an object.");
            }

            signal.throwIfAborted();

            const response = await client.callTool(
              { name: tool.name, arguments: args ?? {} },
              { signal },
            );

            return ToolResult.success({
              content: response.content,
              ...(response.structuredContent === undefined
                ? {}
                : { structuredContent: response.structuredContent }),
              ...(response.isError === undefined ? {} : { isError: response.isError }),
            });
          },
        } satisfies ToolDefinition,
      ]),
    ),
  );
}

function isArguments(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
