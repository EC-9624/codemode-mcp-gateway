/**
 * Process lifetime of the stdio gateway. This module owns the upstream connection,
 * agent-facing transports, created MCP servers, and shutdown listeners; composition
 * supplies each server's fixed-policy executor.
 *
 * Startup loads configuration, connects upstream, and builds a catalog before serving
 * requests. The agent-facing transport opens while upstream setup is pending, so EOF
 * can cancel a stalled handshake or discovery rather than leave startup waiting.
 *
 * EOF, SIGINT, and SIGTERM abort setup and active executions. Cleanup closes the MCP
 * servers before releasing upstream resources, including on partial startup. Stdio
 * waits for the child's actual close; HTTP requests session deletion before closing.
 */
import { dirname } from "node:path";
import { type McpServer } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { readConfiguration } from "./config.ts";
import { createServer } from "./composition.ts";
import { connectUpstream } from "./upstream.ts";
import { type CredentialOptions } from "./auth/login.ts";

/**
 * Load configuration and serve MCP on process stdin/stdout until EOF or a shutdown signal.
 * Installs SIGINT/SIGTERM listeners for this call and removes them during cleanup.
 * Resolves after shutdown cleanup; uncancelled startup and cleanup failures reject.
 */
export async function serve(path: string, options: CredentialOptions = {}): Promise<void> {
  const config = await readConfiguration(path);
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

  const upstreamCleanup = cleanup.use(new AsyncDisposableStack());
  const servers = new Set<McpServer>();
  cleanup.defer(async () => {
    for (const server of servers) await server.close();
  });

  const ready = connectUpstream(config.upstream, dirname(path), shutdown.signal, options).then(
    (upstream) => {
      upstreamCleanup.use(upstream);

      const create = () => {
        const server = createServer(upstream.catalog, config.sandbox);
        server.server.onerror = () => console.error("CMG sandbox execution failed.");
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
  );

  const wire = new StdioServerTransport();

  const entry = serveStdio(async () => (await ready)(), {
    transport: wire,
    onerror: () => console.error("CMG protocol error."),
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
