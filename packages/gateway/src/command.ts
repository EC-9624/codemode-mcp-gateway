import { parseArgs } from "node:util";

export type Command =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "token" }
  | { kind: "setup"; path: string | undefined }
  | { kind: "check"; path: string | undefined; json: boolean }
  | {
      kind: "doctor";
      path: string | undefined;
      server: string | undefined;
      json: boolean;
      transport: "http" | "stdio";
    }
  | { kind: "login"; path: string | undefined; server: string | undefined }
  | { kind: "logout"; path: string | undefined; server: string | undefined }
  | { kind: "serve"; path: string | undefined; transport: "http" | "stdio" };

/** Normalize legacy invocation and reject incompatible flags before command execution. */
export function parseCommand(
  args: readonly string[],
): { ok: true; command: Command } | { ok: false } {
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
    return { ok: false };
  }

  if (parsed.values.help || args.length === 0) return { ok: true, command: { kind: "help" } };

  if (parsed.values.version) return { ok: true, command: { kind: "version" } };

  const first = parsed.positionals[0];

  const named =
    first === "setup" ||
    first === "token" ||
    first === "serve" ||
    first === "check" ||
    first === "doctor" ||
    first === "login" ||
    first === "logout"
      ? first
      : undefined;

  const positionals = named === undefined ? parsed.positionals : parsed.positionals.slice(1);
  const path = parsed.values.config ?? positionals[0];
  const server = parsed.values.server;
  const json = parsed.values.json ?? false;
  const stdio = parsed.values.stdio ?? false;

  if (
    first === "service" ||
    positionals.length > 1 ||
    (parsed.values.config !== undefined && positionals.length !== 0) ||
    (path !== undefined && !path.trim()) ||
    (server !== undefined && !server.trim())
  )
    return { ok: false };

  if (server !== undefined && named !== "doctor" && named !== "login" && named !== "logout")
    return { ok: false };

  if (json && named !== "check" && named !== "doctor") return { ok: false };

  if (stdio && named !== undefined && named !== "serve" && named !== "doctor") return { ok: false };

  if (named === "token")
    return path === undefined ? { ok: true, command: { kind: "token" } } : { ok: false };

  if (named === "setup") return { ok: true, command: { kind: "setup", path } };

  if (named === "check") return { ok: true, command: { kind: "check", path, json } };

  if (named === "login" || named === "logout")
    return { ok: true, command: { kind: named, path, server } };

  if (named === "doctor")
    return {
      ok: true,
      command: { kind: "doctor", path, server, json, transport: stdio ? "stdio" : "http" },
    };

  // Bare paths and --config without a named command retain legacy direct stdio behavior.
  return {
    ok: true,
    command: { kind: "serve", path, transport: stdio || named === undefined ? "stdio" : "http" },
  };
}
