import { dirname } from "node:path";
import { z } from "zod";
import { serve } from "./server.ts";
import { login, logout } from "./auth/login.ts";
import { type CredentialOptions } from "./auth/credentials.ts";
import { AuthorizationError } from "./auth/result.ts";
import { GatewayError } from "./errors.ts";
import {
  configurationPath,
  configuredServer,
  readConfiguration,
  type Configuration,
} from "./config.ts";
import { Gateway, type ServerStatus } from "./gateway.ts";
import { serveHttp } from "./daemon.ts";
import { httpToken } from "./http-token.ts";
import { httpStatus } from "./status.ts";
import { setup } from "./setup.ts";
import { commandHelp, parseCommand } from "./command.ts";

// Standalone builds embed this value; ordinary package/source runs read their manifest.
declare const GW_BUILD_VERSION: string;

/** CLI boundaries render only deliberately public errors. */
export async function main(
  args: readonly string[],
  options: CredentialOptions = {},
): Promise<number> {
  const parsed = parseCommand(args);
  if (!parsed.ok) {
    const topic = parsed.topic === "root" ? "" : " " + parsed.topic;
    console.error(`${parsed.message}\nRun gw help${topic} for usage.`);

    return 2;
  }

  const command = parsed.command;
  if (command.kind === "help") {
    console.log(commandHelp(command.topic));

    return 0;
  }

  if (command.kind === "version") {
    const version =
      typeof GW_BUILD_VERSION === "undefined"
        ? z
            .object({ version: z.string() })
            .parse(await Bun.file(new URL("../package.json", import.meta.url)).json()).version
        : GW_BUILD_VERSION;

    console.log(`gw ${version}`);

    return 0;
  }

  using listeners = new DisposableStack();
  const shutdown = new AbortController();
  // Preserve signal identity for exit codes; serving owns cleanup and observes this signal too.
  for (const event of ["SIGINT", "SIGTERM"] as const) {
    const stop = () => shutdown.abort(event);
    process.on(event, stop);
    listeners.defer(() => process.off(event, stop));
  }

  try {
    if (command.kind === "token") {
      const token = await httpToken();
      if (shutdown.signal.aborted) return interruptionCode(shutdown.signal);

      console.log(token);

      return 0;
    }

    const path = configurationPath(command.path);
    if (command.kind === "setup") {
      await setup(path, command.transport);

      return shutdown.signal.aborted ? interruptionCode(shutdown.signal) : 0;
    }

    if (command.kind === "login" || command.kind === "logout") {
      const selected = {
        ...options,
        ...(command.server === undefined ? {} : { server: command.server }),
      };

      const result =
        command.kind === "login"
          ? await login(path, { ...selected, signal: shutdown.signal })
          : await logout(path, selected);

      if (shutdown.signal.aborted) return interruptionCode(shutdown.signal);

      const success =
        command.kind === "login"
          ? "Upstream authorization saved."
          : "Local upstream credentials removed. This does not revoke the upstream grant.";

      if (result.ok) console.log(success);
      else console.error(result.error.message);

      return result.ok ? 0 : 1;
    }

    if (command.kind === "check") {
      const config = await readConfiguration(path);
      if (shutdown.signal.aborted) return interruptionCode(shutdown.signal);

      const names = Object.keys(config.mcp.servers);
      if (command.json)
        console.log(JSON.stringify({ ok: true, configuration: path, servers: names }));
      else
        console.log(
          `Configuration valid: ${path} (${names.length} server${names.length === 1 ? "" : "s"}).`,
        );

      return 0;
    }

    if (command.kind === "probe" || command.kind === "status") {
      const config = await readConfiguration(path);

      const remote =
        command.kind === "status"
          ? await httpStatus(config.service.port, await httpToken(), shutdown.signal)
          : undefined;

      let statuses: ServerStatus[];
      if (remote === undefined) {
        await using gateway = new Gateway(selectServer(config, command.server), dirname(path), {
          ...options,
          signal: shutdown.signal,
        });

        await gateway.start();
        statuses = gateway.status();
      } else {
        statuses = remote.upstreams.filter(
          (status) => command.server === undefined || status.name === command.server,
        );
        if (command.server !== undefined && statuses.length === 0)
          throw new GatewayError(
            `Unknown server ${JSON.stringify(command.server)} in the running gateway.`,
          );
      }

      if (shutdown.signal.aborted) return interruptionCode(shutdown.signal);

      const healthy = statuses.every(
        (status) => status.state === "connected" || status.state === "disabled",
      );

      if (command.json)
        console.log(
          JSON.stringify({
            ok: command.kind === "status" || healthy,
            servers: statuses,
            ...(remote === undefined ? {} : { service: remote.service, sessions: remote.sessions }),
          }),
        );
      else
        for (const status of statuses)
          console.log(
            `${status.name}: ${status.state} (${status.toolCount} tools)${"error" in status ? " — " + status.error.message : ""}`,
          );

      return command.kind === "status" || healthy ? 0 : 1;
    }

    if (command.transport === "stdio") await serve(path, { ...options, signal: shutdown.signal });
    else await serveHttp(path, { ...options, signal: shutdown.signal });

    return shutdown.signal.aborted ? interruptionCode(shutdown.signal) : 0;
  } catch (error) {
    if (shutdown.signal.aborted) return interruptionCode(shutdown.signal);

    const message =
      error instanceof GatewayError || error instanceof AuthorizationError
        ? error.message
        : "Gateway command failed. Private diagnostics were not displayed.";

    if (
      (command.kind === "check" || command.kind === "probe" || command.kind === "status") &&
      command.json
    )
      console.log(JSON.stringify({ ok: false, error: { message } }));
    else console.error(message);

    return 1;
  }
}

function interruptionCode(signal: AbortSignal): number {
  return signal.reason === "SIGTERM" ? 143 : 130;
}

function selectServer(config: Configuration, name: string | undefined): Configuration {
  if (name === undefined) return config;

  const selected = configuredServer(config, name);

  return {
    service: config.service,
    sandbox: config.sandbox,
    mcp: { servers: { [name]: selected } },
  };
}
