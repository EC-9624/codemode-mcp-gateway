/**
 * Process lifetime of the stdio gateway. Gateway owns connections and MCP instances.
 *
 * Discovery/status is available while upstreams initialize independently. EOF cancels setup.
 * Gateway events use terminal text or structured JSON on stderr;
 * agents receive public protocol messages but only `Host tool failed.` for unknown exceptions.
 *
 * EOF, SIGINT, and SIGTERM abort setup and active executions. Cleanup closes the MCP
 * servers before releasing upstream resources, including on partial startup. Stdio
 * waits for the child's actual close; HTTP requests session deletion before closing.
 */
import { dirname } from "node:path";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { readConfiguration } from "../config.ts";
import { type CredentialOptions } from "../auth/credentials.ts";
import { Gateway } from "../gateway.ts";
import { Logger } from "../observability/logger.ts";

/**
 * Load configuration and serve MCP on process stdin/stdout until EOF or a shutdown signal.
 * Installs SIGINT/SIGTERM listeners for this call and removes them during cleanup.
 * An optional host signal also cancels startup and serving; its reason stays private.
 * Resolves after shutdown cleanup; uncancelled startup and cleanup failures reject.
 */
export async function serve(
  path: string,
  options: CredentialOptions & { signal?: AbortSignal; logger?: Logger } = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  const config = await readConfiguration(path);
  options.signal?.throwIfAborted();
  await using cleanup = new AsyncDisposableStack();
  const logger = options.logger ?? (await Logger.fromEnvironment());

  const started = performance.now();
  let reason: "signal" | "host" | "failure" | "eof" = "host";
  cleanup.defer(() =>
    logger.emit({
      name: "gw.service.stopped",
      attributes: {
        "gw.transport": "stdio",
        "gw.shutdown.reason": reason,
        "gw.service.duration_ms": performance.now() - started,
      },
    }),
  );
  const shutdown = new AbortController();
  const stopped = Promise.withResolvers<void>();

  const stop = () => {
    if (
      !shutdown.signal.aborted &&
      (options.signal?.reason === "SIGINT" || options.signal?.reason === "SIGTERM")
    )
      reason = "signal";

    shutdown.abort();
    stopped.resolve();
  };

  cleanup.defer(() => options.signal?.removeEventListener("abort", stop));
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();

  for (const event of ["SIGINT", "SIGTERM"] as const) {
    const interrupted = () => {
      reason = "signal";
      stop();
    };

    process.on(event, interrupted);
    cleanup.defer(() => {
      process.off(event, interrupted);
    });
  }

  if (shutdown.signal.aborted) return;

  const gateway = new Gateway(config, dirname(path), {
    ...options,
    signal: shutdown.signal,
    logger,
  });

  cleanup.defer(async () => {
    try {
      await gateway.close();
    } catch (cause) {
      reason = "failure";
      logger.emit({
        name: "gw.service.failed",
        attributes: { "gw.component": "cleanup", "error.type": "cleanup" },
      });
      throw cause;
    }
  });

  const ready = gateway.start();

  const wire = new StdioServerTransport();

  const entry = serveStdio(
    () => {
      return gateway.createServer({ transport: "stdio", closeReason: () => "transport" });
    },
    {
      transport: wire,
      onerror: () =>
        logger.emit({
          name: "gw.service.failed",
          attributes: { "gw.component": "stdio", "error.type": "mcp_protocol" },
        }),
    },
  );

  cleanup.defer(() => entry.close());
  logger.emit({
    name: "gw.service.started",
    attributes: { "gw.transport": "stdio", "process.pid": process.pid },
  });
  // Preserve the SDK's close callback while observing EOF even before handshake.
  const onClose = wire.onclose;
  wire.onclose = () => {
    onClose?.();
    if (!shutdown.signal.aborted) reason = "eof";

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
    if (!shutdown.signal.aborted) {
      reason = "failure";
      logger.emit({
        name: "gw.service.failed",
        attributes: { "gw.component": "stdio", "error.type": "infrastructure" },
      });
      throw error;
    }
  } finally {
    stop();
  }
}
