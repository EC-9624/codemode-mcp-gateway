import { dirname } from "node:path";
import { readConfiguration } from "../config.ts";
import { Gateway } from "../gateway.ts";
import { GatewayHttpServer } from "./server.ts";
import { httpToken } from "./token.ts";
import { GatewayError } from "../errors.ts";
import { type CredentialOptions } from "../auth/credentials.ts";
import { Logger } from "../observability/logger.ts";

/** Foreground HTTP process; deployment and client configuration belong to the caller. */
export async function serveHttp(
  path: string,
  options: CredentialOptions & { signal?: AbortSignal; logger?: Logger } = {},
) {
  options.signal?.throwIfAborted();
  const config = await readConfiguration(path);
  options.signal?.throwIfAborted();
  const bearerToken = await httpToken();
  options.signal?.throwIfAborted();
  await using cleanup = new AsyncDisposableStack();
  const logger = options.logger ?? (await Logger.fromEnvironment());

  const started = performance.now();
  let reason: "signal" | "host" | "failure" = "host";
  cleanup.defer(() =>
    logger.emit({
      name: "gw.service.stopped",
      attributes: {
        "gw.transport": "http",
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

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const interrupted = () => {
      reason = "signal";
      stop();
    };

    process.on(signal, interrupted);
    cleanup.defer(() => {
      process.off(signal, interrupted);
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

  const opened = await GatewayHttpServer.listen(gateway, {
    port: config.service.port,
    bearerToken,
  });

  if (!opened.ok) {
    reason = "failure";
    logger.emit({
      name: "gw.service.failed",
      attributes: { "gw.component": "http", "error.type": opened.error.kind },
    });
    throw new GatewayError(opened.error.message);
  }

  cleanup.use(opened.server);
  if (shutdown.signal.aborted) return;

  // Bind before connecting upstreams: an occupied port must not create a second
  // gateway's connections. Upstreams may remain needs-auth without blocking MCP.
  const starting = gateway.start();
  logger.emit({
    name: "gw.service.started",
    attributes: {
      "gw.transport": "http",
      "server.port": Number(opened.server.url.port),
      "process.pid": process.pid,
    },
  });
  try {
    await Promise.race([
      stopped.promise,
      starting
        .then(() => gateway.failure)
        .then((cause) => {
          throw cause;
        }),
      opened.server.failure.then((cause) => {
        throw cause;
      }),
    ]);
  } catch (cause) {
    reason = "failure";
    logger.emit({
      name: "gw.service.failed",
      attributes: { "gw.component": "http", "error.type": "infrastructure" },
    });
    throw cause;
  } finally {
    stop();
  }
}
