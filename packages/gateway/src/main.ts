import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { serve } from "./server.ts";
import { login, logout, type CredentialOptions } from "./auth/login.ts";
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

type Command = "setup" | "token" | "serve" | "check" | "doctor" | "login" | "logout";

/** CLI boundaries render only deliberately public errors. */
export async function main(
  args: readonly string[],
  options: CredentialOptions = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        config: { type: "string", short: "c" },
        server: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        stdio: { type: "boolean" },
      },
    });
  } catch {
    console.error("Invalid arguments. Run gw --help for usage.");

    return 2;
  }

  if (parsed.values.help || args.length === 0) {
    console.log(help);

    return 0;
  }

  if (parsed.values.version) {
    const version =
      typeof GW_BUILD_VERSION === "undefined"
        ? z
            .object({ version: z.string() })
            .parse(await Bun.file(new URL("../package.json", import.meta.url)).json()).version
        : GW_BUILD_VERSION;

    console.log(`gw ${version}`);

    return 0;
  }

  const positionals = [...parsed.positionals];
  const first = positionals[0];
  let command: Command = "serve";
  if (
    first === "setup" ||
    first === "token" ||
    first === "serve" ||
    first === "check" ||
    first === "doctor" ||
    first === "login" ||
    first === "logout"
  ) {
    command = first;
    positionals.shift();
  }

  const explicit = parsed.values.config ?? positionals[0];
  const server = parsed.values.server;
  if (
    first === "service" ||
    (command === "token" &&
      (explicit !== undefined || parsed.values.json || parsed.values.stdio)) ||
    positionals.length > 1 ||
    (parsed.values.config !== undefined && positionals.length !== 0) ||
    (explicit !== undefined && !explicit.trim()) ||
    (server !== undefined && !server.trim()) ||
    (server !== undefined && command !== "doctor" && command !== "login" && command !== "logout") ||
    (parsed.values.json && command !== "check" && command !== "doctor") ||
    (parsed.values.stdio && command !== "serve" && command !== "doctor")
  ) {
    console.error("Invalid arguments. Run gw --help for usage.");

    return 2;
  }

  using listeners = new DisposableStack();
  const shutdown = new AbortController();
  if (command !== "serve") {
    for (const event of ["SIGINT", "SIGTERM"] as const) {
      const stop = () => shutdown.abort();
      process.on(event, stop);
      listeners.defer(() => process.off(event, stop));
    }
  }

  try {
    if (command === "token") {
      const token = await httpToken();
      if (shutdown.signal.aborted) return 130;

      console.log(token);

      return 0;
    }

    const path = configurationPath(explicit);
    if (command === "setup") {
      await setup(path);

      return shutdown.signal.aborted ? 130 : 0;
    }

    if (command === "login" || command === "logout") {
      const selected = { ...options, ...(server === undefined ? {} : { server }) };

      const result =
        command === "login"
          ? await login(path, { ...selected, signal: shutdown.signal })
          : await logout(path, selected);

      if (shutdown.signal.aborted) return 130;

      const success =
        command === "login"
          ? "Upstream authorization saved."
          : "Local upstream credentials removed. This does not revoke the upstream grant.";

      console.error(result.ok ? success : result.error.message);

      return result.ok ? 0 : 1;
    }

    if (command === "check") {
      const config = await readConfiguration(path);
      if (shutdown.signal.aborted) return 130;

      const names = Object.keys(config.mcp.servers);
      if (parsed.values.json)
        console.log(JSON.stringify({ ok: true, configuration: path, servers: names }));
      else
        console.log(
          `Configuration valid: ${path} (${names.length} server${names.length === 1 ? "" : "s"}).`,
        );

      return 0;
    }

    if (command === "doctor") {
      const config = selectServer(await readConfiguration(path), server);

      const remote = parsed.values.stdio
        ? undefined
        : await httpStatus(config.service.port, await httpToken(), shutdown.signal);

      let statuses: ServerStatus[];
      if (remote === undefined) {
        await using gateway = new Gateway(config, dirname(path), {
          ...options,
          signal: shutdown.signal,
        });

        await gateway.start();
        statuses = gateway.status();
      } else {
        statuses = remote.upstreams.filter(
          (status) => server === undefined || status.name === server,
        );
      }

      if (shutdown.signal.aborted) return 130;

      const healthy = statuses.every(
        (status) => status.state === "connected" || status.state === "disabled",
      );

      if (parsed.values.json)
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

    if (parsed.values.stdio || first !== "serve") await serve(path, options);
    else await serveHttp(path, options);

    return 0;
  } catch (error) {
    if (shutdown.signal.aborted) return 130;

    const message =
      error instanceof GatewayError || error instanceof AuthorizationError
        ? error.message
        : "CMG server failed. Private diagnostics were not displayed.";

    if (parsed.values.json) console.log(JSON.stringify({ ok: false, error: { message } }));
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
