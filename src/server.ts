import { dirname, resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { type McpServer } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { type ToolCatalog } from "./codemode";
import { createCodemodeServer, createMcpCatalog } from "./mcp";
import { Configuration, resolveHeaders } from "./config";

async function main(path: string): Promise<void> {
  let input: unknown;
  try {
    input = await Bun.file(path).json();
  } catch (cause) {
    throw new Error(`Could not read configuration JSON at ${path}.`, { cause });
  }

  const parsed = Configuration.safeParse(input);
  if (!parsed.success) throw new Error("Invalid MCM configuration: " + parsed.error.message);

  const config = parsed.data;
  await using cleanup = new AsyncDisposableStack();
  const shutdown = new AbortController();
  const stopped = Promise.withResolvers<void>();

  const stop = () => {
    shutdown.abort();
    stopped.resolve();
  };

  for (const event of ["SIGINT", "SIGTERM"] as const) {
    process.on(event, stop);
    cleanup.defer(() => {
      process.off(event, stop);
    });
  }

  const transport = createTransport(config.upstream, dirname(path));

  const upstreamClosed = Promise.withResolvers<void>();
  transport.onclose = () => upstreamClosed.resolve();
  const client = new Client({ name: "mcm", version: "0.0.0" });
  const connecting = client.connect(transport, { signal: shutdown.signal, timeout: 5_000 });
  // The default legacy connect starts the child synchronously. The SDK may begin
  // closing after a failed handshake without awaiting that teardown itself.
  const spawned = transport instanceof StdioClientTransport && transport.pid !== null;
  cleanup.defer(async () => {
    if (spawned) await upstreamClosed.promise;
  });
  cleanup.defer(() => transport.close());
  cleanup.defer(() => client.close());
  if (transport instanceof StreamableHTTPClientTransport) {
    cleanup.defer(() => transport.terminateSession());
  }

  const servers = new Set<McpServer>();
  cleanup.defer(async () => {
    for (const server of servers) await server.close();
  });

  const ready = connecting.then(
    async () => {
      let catalog: ToolCatalog;
      try {
        catalog = await createMcpCatalog(client, { signal: shutdown.signal });
      } catch (cause) {
        throw new Error(
          "Upstream tool discovery failed. Check the upstream server's diagnostics.",
          {
            cause,
          },
        );
      }

      const options = {
        catalog,
        sandbox: config.sandbox,
      };

      const create = () => {
        const server = createCodemodeServer(options);
        server.server.onerror = () => console.error("MCM sandbox execution failed.");
        servers.add(server);

        return server;
      };

      // Validate helper-name collisions before announcing a ready server. The SDK
      // can request another instance when switching from a discovery probe to legacy.
      const initial = create();
      let unused = true;

      return () => {
        shutdown.signal.throwIfAborted();
        if (unused) {
          unused = false;

          return initial;
        }

        return create();
      };
    },
    (cause: unknown) => {
      throw new Error(
        "Could not connect to the upstream MCP server. Check its transport configuration and authentication.",
        { cause },
      );
    },
  );

  const wire = new StdioServerTransport();

  const entry = serveStdio(async () => (await ready)(), {
    transport: wire,
    onerror: () => console.error("MCM protocol error."),
  });

  cleanup.defer(() => entry.close());
  // Preserve the SDK's close callback while observing EOF even before handshake.
  const onClose = wire.onclose;
  wire.onclose = () => {
    onClose?.();
    stop();
  };

  try {
    await ready;
    await stopped.promise;
  } catch (error) {
    if (!shutdown.signal.aborted) throw error;
  } finally {
    stop();
  }
}

function createTransport(upstream: Configuration["upstream"], directory: string) {
  if (upstream.transport === "stdio") {
    return new StdioClientTransport({
      command: upstream.command,
      ...(upstream.args === undefined ? {} : { args: upstream.args }),
      ...(upstream.env === undefined ? {} : { env: upstream.env }),
      cwd: resolve(directory, upstream.cwd ?? "."),
      stderr: "inherit",
    });
  }

  const resolved = resolveHeaders(upstream.headers);
  if (!resolved.ok) throw new Error(resolved.message);

  return new StreamableHTTPClientTransport(new URL(upstream.url), {
    requestInit: { headers: resolved.headers },
    // Session deletion must not hold shutdown open indefinitely. Ordinary tool
    // requests retain their execution-scoped cancellation and server-owned budget.
    fetch: (url, init) => {
      if (init?.method !== "DELETE") return fetch(url, init);

      const timeout = AbortSignal.timeout(5_000);
      const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;

      return fetch(url, { ...init, signal });
    },
  });
}

const path = process.argv[2];
if (path === undefined || process.argv.length !== 3) {
  console.error("Usage: bun run src/server.ts <configuration.json>");
  process.exitCode = 1;
} else {
  try {
    await main(resolve(path));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "MCM server failed.");
    process.exitCode = 1;
  }
}
