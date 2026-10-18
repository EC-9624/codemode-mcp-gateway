import { parseArgs } from "node:util";

const options = {
  config: { type: "string", short: "c" },
  transport: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

const optionHelp = {
  config: "-c, --config <path>       Override the default configuration",
  transport: "    --transport <mode>    Select http or stdio for serve/setup",
  json: "    --json                Machine-readable config check/probe/status output",
  help: "-h, --help                Show command help",
  version: "-v, --version             Show the installed version",
} as const;

// Parsing and help share the same command-specific option lists.
const commands = {
  setup: {
    usage: "setup [options]",
    description:
      "Prepare gateway configuration\nConfiguration only by default, without connecting. --transport http also prepares an HTTP token.",
    options: ["config", "transport"],
  },
  serve: {
    usage: "serve [options]",
    description:
      "Run foreground HTTP MCP (default)\nUses saved setup or GW_HTTP_TOKEN. Use --transport stdio for a client-owned process; stdout is exclusively MCP traffic.",
    options: ["config", "transport"],
  },
  "config check": {
    usage: "config check [options]",
    description: "Validate configuration without connecting",
    options: ["config", "json"],
  },
  probe: {
    usage: "probe [server] [options]",
    description:
      "Test fresh upstream connections\nConnections are closed after reporting. Omit server to probe all configured upstreams. This does not inspect a running gateway.",
    options: ["config", "json"],
  },
  status: {
    usage: "status [server] [options]",
    description:
      "Read the running HTTP gateway's status\nNo upstream connections are opened. This cannot inspect a client-owned stdio gateway. Degraded upstreams are reported as data.",
    options: ["config", "json"],
  },
  "auth login": {
    usage: "auth login [server] [options]",
    description:
      "Authorize a named upstream\nOmit server only when exactly one OAuth upstream is configured. For a leading-hyphen server name, put options first and use -- before the name.",
    options: ["config"],
  },
  "auth logout": {
    usage: "auth logout [server] [options]",
    description:
      "Remove local upstream credentials\nThis does not revoke the provider's grant. Omit server only when exactly one OAuth upstream is configured.",
    options: ["config"],
  },
  "token show": {
    usage: "token show",
    description:
      "Print the effective HTTP token (sensitive)\nExplicit use only: do not log or commit it. Uses GW_HTTP_TOKEN when set, otherwise the token prepared by gw setup --transport http.",
    options: [],
  },
} as const satisfies Record<
  string,
  {
    usage: string;
    description: string;
    options: readonly (keyof typeof options)[];
  }
>;

type CommandName = keyof typeof commands;
type HelpTopic = "root" | "config" | "auth" | "token" | CommandName;
type Transport = "http" | "stdio";

export type Command =
  | { kind: "help"; topic: HelpTopic }
  | { kind: "version" }
  | { kind: "token" }
  | { kind: "setup"; path: string | undefined; transport: Transport }
  | { kind: "serve"; path: string | undefined; transport: Transport }
  | { kind: "check"; path: string | undefined; json: boolean }
  | { kind: "probe"; path: string | undefined; server: string | undefined; json: boolean }
  | { kind: "status"; path: string | undefined; server: string | undefined; json: boolean }
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
    name === "probe" || name === "status" || name === "auth login" || name === "auth logout";

  if (rest.length > (acceptsServer && !help ? 1 : 0))
    return {
      ok: false,
      message: `Unexpected arguments for gw ${name}. Use --config <path> for configuration.`,
      topic,
    };

  const path = parsed.values.config;
  if (path !== undefined && path.trim() === "")
    return { ok: false, message: "--config must be a non-empty path.", topic };

  const server = rest[0];
  if (server !== undefined && server.trim() === "")
    return { ok: false, message: "Server must be a non-empty name.", topic };

  const transport = parsed.values.transport ?? (name === "serve" ? "http" : "stdio");
  if (transport !== "stdio" && transport !== "http")
    return { ok: false, message: "--transport must be stdio or http.", topic };

  if (help || parsed.values.help || name === "config" || name === "auth" || name === "token")
    return { ok: true, command: { kind: "help", topic } };

  if (name === "root")
    return {
      ok: true,
      command: parsed.values.version ? { kind: "version" } : { kind: "help", topic },
    };

  const json = parsed.values.json ?? false;
  switch (name) {
    case "setup":
    case "serve":
      return { ok: true, command: { kind: name, path, transport } };
    case "config check":
      return { ok: true, command: { kind: "check", path, json } };
    case "probe":
    case "status":
      return { ok: true, command: { kind: name, path, server, json } };
    case "auth login":
      return { ok: true, command: { kind: "login", path, server } };
    case "auth logout":
      return { ok: true, command: { kind: "logout", path, server } };
    case "token show":
      return { ok: true, command: { kind: "token" } };
  }
}

export function commandHelp(topic: HelpTopic): string {
  if (isCommandName(topic)) {
    const definition = commands[topic];

    return `Usage: gw ${definition.usage}\n\n${definition.description}\n\nOptions:\n${[...definition.options, "help" as const].map((name) => "  " + optionHelp[name]).join("\n")}\n`;
  }

  const entries = Object.entries(commands).filter(
    ([name]) => topic === "root" || name.startsWith(`${topic} `),
  );

  const rows = entries.map(([, definition]) => ({
    label: `gw ${definition.usage.replace(" [options]", "")}`,
    description: definition.description.split("\n")[0],
  }));

  if (topic === "root") rows.unshift({ label: "gw", description: "Show this help" });

  rows.push({ label: "gw help [command...]", description: "Show command help" });
  const width = Math.max(...rows.map((row) => row.label.length)) + 2;
  const helpOptions = topic === "root" ? Object.values(optionHelp) : [optionHelp.help];

  return `Usage: gw${topic === "root" ? "" : " " + topic} <command> [options]

${rows.map((row) => `  ${row.label.padEnd(width)}${row.description}`).join("\n")}

Options:
${helpOptions.map((line) => "  " + line).join("\n")}
${topic === "root" ? "\nDefault configuration: $XDG_CONFIG_HOME/codemode-mcp-gateway/config.json, or ~/.config/codemode-mcp-gateway/config.json.\nUse --config <path> on configuration-based commands. Client configuration and installation are user-managed.\nStdio needs no gateway HTTP token; upstream OAuth login remains explicit.\n" : ""}`;
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
    isCommandName(value)
  );
}
