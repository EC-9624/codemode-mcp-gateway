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
import { parseCommand } from "./command.ts";

// Standalone builds embed this value; ordinary package/source runs read their manifest.
declare const GW_BUILD_VERSION: string;

const help = `Usage: gw [setup|token|serve|check|doctor|login|logout] [configuration.json] [options]

  gw                         Show this help
  gw setup                   Prepare gateway configuration and a private HTTP token
  gw token                   Print the effective HTTP token (sensitive; explicit use only)
  gw serve                   Run foreground HTTP MCP using saved setup or GW_HTTP_TOKEN
  gw serve --stdio           Run an explicit direct stdio gateway
  gw <configuration.json>    Legacy explicit-path stdio mode
  gw check                   Validate configuration without connecting
  gw doctor                  Read the running service's upstream status
  gw login --server <name>   Authorize a named upstream
  gw logout --server <name>  Remove its local credentials

Options:
  -c, --config <path>  Override configuration for any command
      --server <name>  Select an upstream for doctor, login, or logout
      --json           Machine-readable check/doctor output
      --stdio          Explicit direct stdio serving or fresh doctor probe
  -h, --help           Show this help
  -v, --version        Show the installed version

Default: $XDG_CONFIG_HOME/codemode-mcp-gateway/config.json, or ~/.config/codemode-mcp-gateway/config.json.
Run gw setup once, configure your upstreams and clients, then gw serve.
HTTP serve/doctor use GW_HTTP_TOKEN when set, otherwise the private setup-created token.
Tokens contain 32–256 letters, digits, underscores, or hyphens.
Supply the same persistent token in your MCP clients; rotate it explicitly when needed.
Client configuration, installation, and process supervision are user-managed.
Stdio serving writes MCP to stdout and diagnostics to stderr. Login is explicit;
running multi-upstream gateways recover automatically after credentials change.`;

/** CLI boundaries render only deliberately public errors. */
export async function main(
  args: readonly string[],
  options: CredentialOptions = {},
): Promise<number> {
  const parsed = parseCommand(args);
  if (!parsed.ok) {
    console.error("Invalid arguments. Run gw --help for usage.");

    return 2;
  }

  const command = parsed.command;
  if (command.kind === "help") {
    console.log(help);

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
  if (command.kind !== "serve") {
    for (const event of ["SIGINT", "SIGTERM"] as const) {
      const stop = () => shutdown.abort();
      process.on(event, stop);
      listeners.defer(() => process.off(event, stop));
    }
  }

  try {
    if (command.kind === "token") {
      const token = await httpToken();
      if (shutdown.signal.aborted) return 130;

      console.log(token);

      return 0;
    }

    const path = configurationPath(command.path);
    if (command.kind === "setup") {
      await setup(path);

      return shutdown.signal.aborted ? 130 : 0;
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

      if (shutdown.signal.aborted) return 130;

      const success =
        command.kind === "login"
          ? "Upstream authorization saved."
          : "Local upstream credentials removed. This does not revoke the upstream grant.";

      console.error(result.ok ? success : result.error.message);

      return result.ok ? 0 : 1;
    }

    if (command.kind === "check") {
      const config = await readConfiguration(path);
      if (shutdown.signal.aborted) return 130;

      const names = Object.keys(config.mcp.servers);
      if (command.json)
        console.log(JSON.stringify({ ok: true, configuration: path, servers: names }));
      else
        console.log(
          `Configuration valid: ${path} (${names.length} server${names.length === 1 ? "" : "s"}).`,
        );

      return 0;
    }

    if (command.kind === "doctor") {
      const config = await readConfiguration(path);

      const remote =
        command.transport === "stdio"
          ? undefined
          : await httpStatus(config.service.port, await httpToken(), shutdown.signal);

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

      if (shutdown.signal.aborted) return 130;

      const healthy = statuses.every(
        (status) => status.state === "connected" || status.state === "disabled",
      );

      if (command.json)
        console.log(
          JSON.stringify({
            ok: healthy,
            servers: statuses,
            ...(remote === undefined ? {} : { service: remote.service, sessions: remote.sessions }),
          }),
        );
      else
        for (const status of statuses)
          console.log(
            `${status.name}: ${status.state} (${status.toolCount} tools)${"error" in status ? " — " + status.error.message : ""}`,
          );

      return healthy ? 0 : 1;
    }

    if (command.transport === "stdio") await serve(path, options);
    else await serveHttp(path, options);

    return 0;
  } catch (error) {
    if (shutdown.signal.aborted) return 130;

    const message =
      error instanceof GatewayError || error instanceof AuthorizationError
        ? error.message
        : "CMG server failed. Private diagnostics were not displayed.";

    if ((command.kind === "check" || command.kind === "doctor") && command.json)
      console.log(JSON.stringify({ ok: false, error: { message } }));
    else console.error(message);

    return 1;
  }
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
