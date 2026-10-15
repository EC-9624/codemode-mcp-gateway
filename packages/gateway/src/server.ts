/**
 * Process lifetime of the stdio gateway. Gateway owns connections and MCP instances.
 *
 * Discovery/status is available while upstreams initialize independently. EOF cancels setup.
 *
 * EOF, SIGINT, and SIGTERM abort setup and active executions. Cleanup closes the MCP
 * servers before releasing upstream resources, including on partial startup. Stdio
 * waits for the child's actual close; HTTP requests session deletion before closing.
 */
import { dirname } from "node:path";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { readConfiguration } from "./config.ts";
import { type CredentialOptions } from "./auth/login.ts";
import { Gateway } from "./gateway.ts";

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

  const gateway = cleanup.use(
    new Gateway(config, dirname(path), {
      ...options,
      signal: shutdown.signal,
      onStatus: (status) => {
        console.error(
          JSON.stringify({
            server: status.name,
            state: status.state,
            toolCount: status.toolCount,
            ...("error" in status ? { error: status.error } : {}),
          }),
        );
      },
    }),
  );

  const ready = gateway.start();

  const wire = new StdioServerTransport();

  const entry = serveStdio(
    () => {
      const server = gateway.createServer();
      server.server.onerror = () => console.error("CMG sandbox execution failed.");

      return server;
    },
    {
      transport: wire,
      onerror: () => console.error("CMG protocol error."),
    },
  );

  cleanup.defer(() => entry.close());
  // Preserve the SDK's close callback while observing EOF even before handshake.
  const onClose = wire.onclose;
  wire.onclose = () => {
    onClose?.();
    stop();
  };

  try {
    await ready;
    await Promise.race([
      stopped.promise,
      gateway.failure.then((cause) => {
        throw cause;
      }),
    ]);
  } catch (error) {
    if (!shutdown.signal.aborted) throw error;
  } finally {
    stop();
  }
}
