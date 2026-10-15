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

const help = `Usage: cmg [serve|check|doctor|login|logout] [configuration.json] [options]

  cmg                         Serve MCP using the XDG configuration
  cmg <configuration.json>    Serve MCP using an explicit configuration
  cmg check                   Validate configuration without connecting
  cmg doctor                  Check upstream connections and authentication
  cmg login --server <name>   Authorize a named upstream
  cmg logout --server <name>  Remove its local credentials

Options:
  -c, --config <path>  Override configuration for any command
      --server <name>  Select an upstream for doctor, login, or logout
      --json           Machine-readable check/doctor output
  -h, --help           Show this help
  -v, --version        Show the installed version

Default: $XDG_CONFIG_HOME/cmg/config.json, or ~/.config/cmg/config.json.
Serving writes MCP to stdout and diagnostics to stderr. Login is explicit;
running multi-upstream gateways recover automatically after credentials change.`;

type Command = "serve" | "check" | "doctor" | "login" | "logout";

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
      },
    });
  } catch {
    console.error("Invalid arguments. Run cmg --help for usage.");

    return 2;
  }

  if (parsed.values.help) {
    console.log(help);

    return 0;
  }

  if (parsed.values.version) {
    const manifest = z
      .object({ version: z.string() })
      .parse(await Bun.file(new URL("../package.json", import.meta.url)).json());

    console.log(`cmg ${manifest.version}`);

    return 0;
  }

  const positionals = [...parsed.positionals];
  const first = positionals[0];
  let command: Command = "serve";
  if (
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
    positionals.length > 1 ||
    (parsed.values.config !== undefined && positionals.length !== 0) ||
    (explicit !== undefined && !explicit.trim()) ||
    (server !== undefined && !server.trim()) ||
    (server !== undefined && command !== "doctor" && command !== "login" && command !== "logout") ||
    (parsed.values.json && command !== "check" && command !== "doctor")
  ) {
    console.error("Invalid arguments. Run cmg --help for usage.");

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
    const path = configurationPath(explicit);
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

      let statuses: ServerStatus[];
      {
        await using gateway = new Gateway(config, dirname(path), {
          ...options,
          signal: shutdown.signal,
        });

        await gateway.start();
        statuses = gateway.status();
      }

      if (shutdown.signal.aborted) return 130;

      const healthy = statuses.every(
        (status) => status.state === "connected" || status.state === "disabled",
      );

      if (parsed.values.json) console.log(JSON.stringify({ ok: healthy, servers: statuses }));
      else
        for (const status of statuses)
          console.log(
            `${status.name}: ${status.state} (${status.toolCount} tools)${"error" in status ? " — " + status.error.message : ""}`,
          );

      return healthy ? 0 : 1;
    }

    await serve(path, options);

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

  return { sandbox: config.sandbox, mcp: { servers: { [name]: selected } } };
}
