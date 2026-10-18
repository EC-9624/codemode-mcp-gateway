import { parseArgs } from "node:util";
import { toolPageSize, type ToolListOutput } from "./tool-list.ts";
import { wrapText } from "./presentation.ts";

const options = {
  config: { type: "string", short: "c" },
  transport: { type: "string" },
  json: { type: "boolean" },
  all: { type: "boolean" },
  offset: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

const optionHelp = {
  config: "-c, --config <path>       Override the default configuration",
  transport: "    --transport <mode>    Select http or stdio",
  json: "    --json                Print one machine-readable result",
  all: "    --all                 Print every tool in the selection",
  offset: "    --offset <number>     Skip this many tools (default: 0)",
  help: "-h, --help                Show command help",
  version: "-v, --version             Show the installed version",
} as const;

// Parsing and help share the same command-specific option lists.
const commands = {
  setup: {
    group: "Getting started",
    usage: "setup [options]",
    description:
      "Prepare gateway configuration\nConfiguration only by default, without connecting. --transport http also prepares an HTTP token.",
    options: ["config", "transport"],
    examples: [
      "gw setup",
      "gw setup --transport http",
      "gw setup --transport stdio --config ./config.json",
    ],
  },
  serve: {
    group: "Getting started",
    usage: "serve [options]",
    description:
      "Run foreground HTTP MCP (default)\nUses saved setup or GW_HTTP_TOKEN. Use --transport stdio for a client-owned process; stdout is exclusively MCP traffic. Stdio needs no gateway HTTP token.",
    options: ["config", "transport"],
    examples: ["gw serve", "gw serve --config ./config.json", "gw serve --transport stdio"],
  },
  "config check": {
    group: "Inspection",
    usage: "config check [options]",
    description:
      "Validate configuration without connecting\nDefault configuration: $XDG_CONFIG_HOME/codemode-mcp-gateway/config.json, or ~/.config/codemode-mcp-gateway/config.json. Client configuration and services are user-managed.",
    options: ["config", "json"],
    examples: ["gw config check", "gw config check --config ./config.json --json"],
  },
  probe: {
    group: "Inspection",
    usage: "probe [server] [options]",
    description:
      "Test fresh upstream connections\nConnections are closed after reporting. Omit server to probe all configured upstreams. This does not inspect a running gateway.",
    options: ["config", "json"],
    examples: ["gw probe", "gw probe notion", "gw probe notion --json"],
  },
  status: {
    group: "Inspection",
    usage: "status [server] [options]",
    description:
      "Read the running HTTP gateway's status\nNo upstream connections are opened. This cannot inspect a client-owned stdio gateway. Degraded upstreams are reported as data.",
    options: ["config", "json"],
    examples: ["gw status", "gw status notion", "gw status --json"],
  },
  "tools list": {
    group: "Inspection",
    usage: "tools list [server] [options]",
    description: `List available upstream tools\nBrowse ${toolPageSize} tools per page across upstreams, or select one server. Use --offset for the next page or --all for every tool. --json returns the complete selection and cannot be combined with --offset or --all.\nReads only the running HTTP gateway's catalog; no upstream connections or tool calls are started. Use gw status for upstream health.`,
    options: ["config", "json", "all", "offset"],
    examples: [
      "gw tools list",
      `gw tools list notion --offset ${toolPageSize}`,
      "gw tools list --all",
      "gw tools list notion --json",
    ],
  },
  "auth login": {
    group: "Authentication",
    usage: "auth login [server] [options]",
    description:
      "Authorize a named upstream\nOmit server only when exactly one OAuth upstream is configured. For a leading-hyphen server name, put options first and use -- before the name.",
    options: ["config"],
    examples: ["gw auth login notion", "gw auth login notion --config ./config.json"],
  },
  "auth logout": {
    group: "Authentication",
    usage: "auth logout [server] [options]",
    description:
      "Remove local upstream credentials\nThis does not revoke the provider's grant. Omit server only when exactly one OAuth upstream is configured.",
    options: ["config"],
    examples: ["gw auth logout notion", "gw auth logout notion --config ./config.json"],
  },
  "token show": {
    group: "Authentication",
    usage: "token show",
    description:
      "Print the effective HTTP token (sensitive)\nExplicit use only: do not log or commit it. Uses GW_HTTP_TOKEN when set, otherwise the token prepared by gw setup --transport http.",
    options: [],
    examples: ["gw token show"],
  },
} as const satisfies Record<
  string,
  {
    usage: string;
    description: string;
    group: "Getting started" | "Inspection" | "Authentication";
    options: readonly (keyof typeof options)[];
    examples: readonly string[];
  }
>;

type CommandName = keyof typeof commands;
type HelpTopic = "root" | "config" | "auth" | "token" | "tools" | CommandName;
type Transport = "http" | "stdio";

export type Command =
  | { kind: "help"; topic: HelpTopic }
  | { kind: "version" }
  | { kind: "token" }
  | { kind: "setup"; path: string | undefined; transport: Transport | undefined }
  | { kind: "serve"; path: string | undefined; transport: Transport }
  | { kind: "check"; path: string | undefined; json: boolean }
  | { kind: "probe"; path: string | undefined; server: string | undefined; json: boolean }
  | { kind: "status"; path: string | undefined; server: string | undefined; json: boolean }
  | { kind: "tools"; path: string | undefined; output: ToolListOutput }
  | { kind: "login"; path: string | undefined; server: string | undefined }
  | { kind: "logout"; path: string | undefined; server: string | undefined };

type ParsedCommand =
  | { ok: true; command: Command }
  | { ok: false; message: string; topic: HelpTopic };

/** Reject unknown commands, positional configuration paths, and command-incompatible options. */
export function parseCommand(args: readonly string[]): ParsedCommand {
  let parsed;
  try {
    parsed = parseArgs({ args: [...args], allowPositionals: true, tokens: true, options });
  } catch (cause) {
    if (
      !(cause instanceof TypeError) ||
      !("code" in cause) ||
      typeof cause.code !== "string" ||
      !cause.code.startsWith("ERR_PARSE_ARGS_")
    )
      throw cause;

    return { ok: false, message: cause.message, topic: "root" };
  }

  const positionals = parsed.positionals;
  const first = positionals[0];
  const help = first === "help";
  const words = help ? positionals.slice(1) : positionals;
  const pair = words.slice(0, 2).join(" ");
  const name = isCommandName(pair) ? pair : (words[0] ?? "root");
  const topic = isHelpTopic(name) ? name : "root";

  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== "option") continue;

    if (seen.has(token.name))
      return { ok: false, message: `Option --${token.name} may only be supplied once.`, topic };

    seen.add(token.name);
  }

  const allowed: readonly string[] = isCommandName(name) ? commands[name].options : [];
  for (const option of seen) {
    if (option === "help") continue;

    if (!help && name === "root" && option === "version") continue;

    if (help || !allowed.includes(option))
      return {
        ok: false,
        message: `Option --${option} is not supported for ${name === "root" ? "gw" : `gw ${name}`}.`,
        topic,
      };
  }

  if (!isHelpTopic(name))
    return { ok: false, message: `Unknown command ${JSON.stringify(words.join(" "))}.`, topic };

  const consumed = name === "root" ? 0 : name.split(" ").length;
  const rest = words.slice(consumed);

  const acceptsServer =
    name === "probe" ||
    name === "status" ||
    name === "tools list" ||
    name === "auth login" ||
    name === "auth logout";

  if (rest.length > (acceptsServer && !help ? 1 : 0))
    return {
      ok: false,
      message: `Unexpected arguments for gw ${name}.`,
      topic,
    };

  const path = parsed.values.config;
  if (path !== undefined && path.trim() === "")
    return { ok: false, message: "--config must be a non-empty path.", topic };

  const server = rest[0];
  if (server !== undefined && server.trim() === "")
    return { ok: false, message: "Server must be a non-empty name.", topic };

  const transport = parsed.values.transport;
  if (transport !== undefined && transport !== "stdio" && transport !== "http")
    return { ok: false, message: "--transport must be stdio or http.", topic };

  if (
    help ||
    parsed.values.help ||
    name === "config" ||
    name === "auth" ||
    name === "token" ||
    name === "tools"
  )
    return { ok: true, command: { kind: "help", topic } };

  if (name === "root")
    return {
      ok: true,
      command: parsed.values.version ? { kind: "version" } : { kind: "help", topic },
    };

  const json = parsed.values.json ?? false;
  switch (name) {
    case "setup":
      return { ok: true, command: { kind: name, path, transport } };
    case "serve":
      return { ok: true, command: { kind: name, path, transport: transport ?? "http" } };
    case "config check":
      return { ok: true, command: { kind: "check", path, json } };
    case "probe":
    case "status":
      return { ok: true, command: { kind: name, path, server, json } };
    case "tools list": {
      const all = parsed.values.all ?? false;
      const rawOffset = parsed.values.offset;
      if (json && (all || rawOffset !== undefined))
        return {
          ok: false,
          message:
            "--json returns the complete tool list; do not combine it with --all or --offset.",
          topic,
        };

      if (all && rawOffset !== undefined)
        return { ok: false, message: "--all and --offset cannot be combined.", topic };

      const offset = rawOffset === undefined ? 0 : Number(rawOffset);
      if (rawOffset !== undefined && (!/^\d+$/u.test(rawOffset) || !Number.isSafeInteger(offset)))
        return { ok: false, message: "--offset must be a non-negative safe integer.", topic };

      if (json)
        return { ok: true, command: { kind: "tools", path, output: { kind: "json", server } } };

      if (all)
        return { ok: true, command: { kind: "tools", path, output: { kind: "all", server } } };

      return {
        ok: true,
        command: { kind: "tools", path, output: { kind: "page", server, offset } },
      };
    }

    case "auth login":
      return { ok: true, command: { kind: "login", path, server } };
    case "auth logout":
      return { ok: true, command: { kind: "logout", path, server } };
    case "token show":
      return { ok: true, command: { kind: "token" } };
  }
}

export function commandHelp(topic: HelpTopic, width = 80): string {
  if (isCommandName(topic)) {
    const definition = commands[topic];

    const transportNote = topic === "serve" ? " (default: http)" : " (default: configuration only)";

    const flags = [...definition.options, "help" as const].map(
      (name) => "  " + optionHelp[name] + (name === "transport" ? transportNote : ""),
    );

    return `Usage: gw ${definition.usage}\n\n${wrapText(definition.description, width)}\n\nOptions:\n${flags.join("\n")}\n\nExamples:\n${definition.examples.map((example) => "  " + example).join("\n")}\n`;
  }

  const entries = Object.entries(commands).filter(
    ([name]) => topic === "root" || name.startsWith(`${topic} `),
  );

  const rows = entries.map(([, definition]) => ({
    label: `gw ${definition.usage.replace(" [options]", "")}`,
    description: definition.description.split("\n")[0],
    group: definition.group,
  }));

  const labelWidth = Math.max(...rows.map((row) => row.label.length)) + 2;

  const groups =
    topic === "root" ? ["Getting started", "Inspection", "Authentication"] : ["Commands"];

  const sections = groups.map(
    (group) =>
      `${group}:\n${rows
        .filter((row) => topic !== "root" || row.group === group)
        .map((row) => `  ${row.label.padEnd(labelWidth)}${row.description}`)
        .join("\n")}`,
  );

  const helpOptions = topic === "root" ? [optionHelp.help, optionHelp.version] : [optionHelp.help];

  return `Usage: gw${topic === "root" ? "" : " " + topic} <command> [options]

${sections.join("\n\n")}

Options:
${helpOptions.map((line) => "  " + line).join("\n")}
\nRun gw help${topic === "root" ? " <command>" : " " + topic + " <command>"} for flags and examples.\n`;
}

function isCommandName(value: string): value is CommandName {
  return Object.hasOwn(commands, value);
}

function isHelpTopic(value: string): value is HelpTopic {
  return (
    value === "root" ||
    value === "config" ||
    value === "auth" ||
    value === "token" ||
    value === "tools" ||
    isCommandName(value)
  );
}
