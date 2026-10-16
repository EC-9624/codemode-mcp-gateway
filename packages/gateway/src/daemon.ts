import { dirname } from "node:path";
import { configurationIdentity, readConfiguration } from "./config.ts";
import { Gateway } from "./gateway.ts";
import { GatewayHttpServer } from "./http.ts";
import { randomBytes } from "node:crypto";
import { daemonStatus, serviceCredential, upgradeServiceCredential } from "./local-service.ts";
import { reportClients, synchronizeClients } from "./clients.ts";
import { GatewayError } from "./errors.ts";
import { type CredentialOptions } from "./auth/login.ts";
import { ServiceAuthentication } from "./service-auth.ts";

/** Foreground process owned by launchd; client sessions never own this lifetime. */
export async function serveDaemon(path: string, options: CredentialOptions = {}) {
  const config = await readConfiguration(path);
  const saved = await serviceCredential(true);
  if (saved === undefined)
    throw new GatewayError("Could not prepare the local service credential.");

  const key = saved.version === 2 ? saved.key : randomBytes(32).toString("base64url");
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
    }),
  );

  const opened = await GatewayHttpServer.listen(gateway, {
    port: config.service.port,
    serviceKey: key,
    configurationId: configurationIdentity(config, dirname(path)),
  });

  if (!opened.ok) {
    if (opened.error.kind === "address-in-use") {
      const running = await daemonStatus(path).catch((cause: unknown) => {
        if (cause instanceof GatewayError) return undefined;

        throw cause;
      });

      if (running?.service.configurationId === configurationIdentity(config, dirname(path))) {
        const results = await synchronizeClients(
          new URL(`http://127.0.0.1:${config.service.port}/mcp`),
          ServiceAuthentication.bearer(key, running.service.instanceId),
        );

        reportClients(results);
        console.error(
          JSON.stringify({
            event: "already-running",
            pid: running.service.pid,
            url: `http://127.0.0.1:${config.service.port}/mcp`,
          }),
        );

        return;
      }

      if (running !== undefined)
        throw new GatewayError(
          "The port is already in use by a gateway with different or older configuration. Run gw service restart to replace the owned service; client registrations were not changed.",
        );
    }

    throw new GatewayError(opened.error.message);
  }

  cleanup.use(opened.server);
  if (saved.version === 1) await upgradeServiceCredential(saved.token, key);

  const bearerToken = ServiceAuthentication.bearer(key, opened.server.instanceId);
  const clients = await synchronizeClients(opened.server.url, bearerToken);
  opened.server.setClientRegistrations(clients);
  reportClients(clients);
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
