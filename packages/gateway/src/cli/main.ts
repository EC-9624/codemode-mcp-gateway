import { dirname } from "node:path";
import { serve } from "../stdio/serve.ts";
import { login, logout } from "../auth/login.ts";
import { type CredentialOptions } from "../auth/credentials.ts";
import { AuthorizationError } from "../auth/result.ts";
import { GatewayError } from "../errors.ts";
import {
  configurationPath,
  configuredServer,
  readConfiguration,
  type Configuration,
} from "../config.ts";
import { Gateway } from "../gateway.ts";
import { type ServerStatus } from "../server-status.ts";
import { serveHttp } from "../http/serve.ts";
import { httpToken } from "../http/token.ts";
import { httpStatus, httpTools } from "../http/client.ts";
import { formatStatus } from "./status.ts";
import { formatToolList } from "./tool-list.ts";
import { setup } from "./setup.ts";
import { commandHelp, parseCommand } from "./command.ts";
import { outputMode, withProgress, wrapText } from "./presentation.ts";
import { gatewayVersion } from "../version.ts";

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
    console.log(commandHelp(command.topic, process.stdout.columns ?? 80));

    return 0;
  }

  if (command.kind === "version") {
    console.log(`gw ${await gatewayVersion()}`);

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
          ? await withProgress("Waiting for upstream authorization…", true, () =>
              login(path, { ...selected, signal: shutdown.signal }),
            )
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

    if (command.kind === "tools") {
      const config = await readConfiguration(path);
      const listing = await httpTools(config.service.port, await httpToken(), shutdown.signal);
      if (shutdown.signal.aborted) return interruptionCode(shutdown.signal);

      const selected = command.output.server;

      const servers = selectRunningServers(listing.servers, selected);

      const tools = listing.tools.filter(
        (tool) => selected === undefined || tool.server === selected,
      );

      if (command.output.kind === "json") console.log(JSON.stringify({ ok: true, tools, servers }));
      else {
        const rendered = formatToolList(
          { tools, servers },
          command.output,
          outputMode(process.stdout),
        );

        if (rendered.stdout !== "") console.log(rendered.stdout);

        if (rendered.stderr !== "") console.error(rendered.stderr);
      }

      return 0;
    }

    if (command.kind === "probe" || command.kind === "status") {
      const config = await readConfiguration(path);

      const remote =
        command.kind === "status"
          ? await httpStatus(config.service.port, await httpToken(), shutdown.signal)
          : undefined;

      const statuses =
        remote === undefined
          ? await withProgress("Checking upstream connections…", !command.json, () =>
              probeServers(config, path, command.server, { ...options, signal: shutdown.signal }),
            )
          : selectRunningServers(remote.upstreams, command.server);

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
      else {
        const rendered = formatStatus(
          statuses,
          outputMode(process.stdout),
          remote === undefined
            ? { kind: "probe" }
            : { kind: "http", port: config.service.port, status: remote },
        );

        if (rendered !== "") console.log(rendered);
      }

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
      ((command.kind === "check" || command.kind === "probe" || command.kind === "status") &&
        command.json) ||
      (command.kind === "tools" && command.output.kind === "json")
    )
      console.log(JSON.stringify({ ok: false, error: { message } }));
    else {
      const mode = outputMode(process.stderr);
      console.error(mode.kind === "terminal" ? wrapText(message, mode.width) : message);
    }

    return 1;
  }
}

function interruptionCode(signal: AbortSignal): number {
  return signal.reason === "SIGTERM" ? 143 : 130;
}

async function probeServers(
  config: Configuration,
  path: string,
  server: string | undefined,
  options: CredentialOptions & { signal: AbortSignal },
): Promise<ServerStatus[]> {
  await using gateway = new Gateway(selectServer(config, server), dirname(path), options);

  await gateway.start();

  return gateway.status();
}

function selectRunningServers(statuses: ServerStatus[], name: string | undefined): ServerStatus[] {
  const selected = statuses.filter((status) => name === undefined || status.name === name);
  if (name !== undefined && selected.length === 0)
    throw new GatewayError(`Unknown server ${JSON.stringify(name)} in the running gateway.`);

  return selected;
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
