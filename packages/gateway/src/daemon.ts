import { dirname } from "node:path";
import { readConfiguration } from "./config.ts";
import { Gateway } from "./gateway.ts";
import { GatewayHttpServer, httpToken } from "./http.ts";
import { GatewayError } from "./errors.ts";
import { type CredentialOptions } from "./auth/login.ts";
import { reportToolException } from "./diagnostics.ts";

/** Foreground HTTP process; deployment and client configuration belong to the caller. */
export async function serveHttp(path: string, options: CredentialOptions = {}) {
  const config = await readConfiguration(path);
  const bearerToken = httpToken();
  await using cleanup = new AsyncDisposableStack();
  const shutdown = new AbortController();
  const stopped = Promise.withResolvers<void>();

  const stop = () => {
    shutdown.abort();
    stopped.resolve();
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, stop);
    cleanup.defer(() => {
      process.off(signal, stop);
    });
  }

  const gateway = cleanup.use(
    new Gateway(config, dirname(path), {
      ...options,
      signal: shutdown.signal,
      onStatus: (status) => console.error(JSON.stringify(status)),
      onToolException: reportToolException,
    }),
  );

  const opened = await GatewayHttpServer.listen(gateway, {
    port: config.service.port,
    bearerToken,
  });

  if (!opened.ok) throw new GatewayError(opened.error.message);

  cleanup.use(opened.server);
  if (shutdown.signal.aborted) return;

  // Bind before connecting upstreams: an occupied port must not create a second
  // gateway's connections. Upstreams may remain needs-auth without blocking MCP.
  const starting = gateway.start();
  console.error(
    JSON.stringify({ event: "listening", pid: process.pid, url: opened.server.url.href }),
  );
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
  } finally {
    stop();
  }
}
