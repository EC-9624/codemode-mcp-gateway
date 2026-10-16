import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseTOML, ParseError } from "toml-eslint-parser";
import { z } from "zod";

const name = "codemode-mcp-gateway";

// Retain every unrelated own key. Zod record reconstruction drops __proto__,
// which must not silently erase user configuration during a credential update.
const object = z.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
);

const client = z.enum(["codex", "claude"]);
export const ClientRegistration = z.discriminatedUnion("state", [
  z.object({ client, state: z.enum(["configured", "unchanged"]), path: z.string() }),
  z.object({ client, state: z.literal("not-installed") }),
  z.object({ client, state: z.literal("failed"), message: z.string() }),
]);
export type ClientRegistration = z.infer<typeof ClientRegistration>;

type Target = { client: z.infer<typeof client>; path: string };
type Result<T> = { ok: true; value: T } | { ok: false; message: string };
type Snapshot = { text: string; ino: number; dev: number; mode: number };

/** CLI-only setup. Neither importing the gateway nor borrowing its HTTP host invokes this. */
export async function synchronizeClients(url: URL, token: string): Promise<ClientRegistration[]> {
  const home = homedir();
  const codex = process.env.CODEX_HOME || join(home, ".codex");
  const claude = process.env.CLAUDE_CONFIG_DIR;

  const targets: Target[] = [
    { client: "codex", path: join(codex, "config.toml") },
    { client: "claude", path: claude ? join(claude, ".claude.json") : join(home, ".claude.json") },
  ];

  const results: ClientRegistration[] = [];
  for (const target of targets) {
    if (!isAbsolute(target.path)) {
      results.push({
        client: target.client,
        state: "failed",
        message: "The native client configuration directory must be absolute.",
      });
      continue;
    }

    try {
      const exists = await info(target.path);
      const directory = target.client === "codex" ? codex : claude || join(home, ".claude");
      if (
        exists === undefined &&
        (await info(directory)) === undefined &&
        Bun.which(target.client) === null
      ) {
        results.push({ client: target.client, state: "not-installed" });
        continue;
      }

      const result = await synchronize(target, url.href, token);
      results.push(
        result.ok
          ? { client: target.client, state: result.value, path: target.path }
          : { client: target.client, state: "failed", message: result.message },
      );
    } catch (cause) {
      // Only recognized filesystem/lock failures are recoverable registration errors.
      // Never include dependency messages: they may quote secret-bearing input.
      if (
        !isCode(cause, [
          "EACCES",
          "EPERM",
          "EROFS",
          "ENOTDIR",
          "ELOOP",
          "ELOCKED",
          "ENOSPC",
          "EIO",
          "ENOENT",
        ])
      )
        throw cause;

      results.push({
        client: target.client,
        state: "failed",
        message:
          "Could not update the private client config. Check its permissions and retry gw serve; another writer may hold its lock.",
      });
    }
  }

  return results;
}

export function reportClients(results: ClientRegistration[]) {
  for (const result of results)
    console.error(JSON.stringify({ event: "client-registration", ...result }));
}

async function synchronize(
  target: Target,
  url: string,
  token: string,
): Promise<Result<"configured" | "unchanged">> {
  const parent = dirname(target.path);
  const directory = await info(parent);
  if (directory?.isSymbolicLink())
    return {
      ok: false,
      message:
        "Refusing a symlinked client configuration directory. Use a private local directory.",
    };

  // A regular file can still be tracked, even without a Stow symlink. Do not
  // place credentials anywhere inside a Git checkout (including worktrees).
  let ancestor = await realpath(await closestDirectory(parent));
  while (true) {
    if ((await info(join(ancestor, ".git"))) !== undefined)
      return {
        ok: false,
        message:
          "Refusing to write credentials inside a Git checkout. Move the native client config to a private local directory.",
      };

    const next = dirname(ancestor);
    if (next === ancestor) break;

    ancestor = next;
  }

  await mkdir(parent, { recursive: true, mode: 0o700 });
  const { lock } = await import("proper-lockfile");
  let compromised = false;

  const unlock = await lock(target.path + ".gw", {
    realpath: false,
    retries: 0,
    stale: 10_000,
    update: 1_000,
    onCompromised: () => {
      compromised = true;
    },
  });

  try {
    const loaded = await read(target.path);
    if (!loaded.ok) return loaded;

    const edited = edit(target.client, loaded.value?.text ?? "", url, token);
    if (!edited.ok) return edited;

    if (loaded.value?.text === edited.value && (loaded.value.mode & 0o777) === 0o600)
      return { ok: true, value: "unchanged" };

    const temporary = join(parent, `.gw-${crypto.randomUUID()}.tmp`);

    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );

    try {
      try {
        await file.writeFile(edited.value);
      } finally {
        await file.close();
      }

      const current = await read(target.path);
      if (!current.ok) return current;

      // Other applications do not honor our lock. Detect observed edits before
      // replacement; this is not a cross-application transactional guarantee.
      if (compromised || !isDeepStrictEqual(current.value, loaded.value))
        return {
          ok: false,
          message:
            "The client config changed during registration. Retry gw serve after the other writer finishes.",
        };

      await rename(temporary, target.path);
    } finally {
      await rm(temporary, { force: true });
    }

    return { ok: true, value: "configured" };
  } finally {
    await unlock();
  }
}

function edit(client: Target["client"], text: string, url: string, token: string): Result<string> {
  let value: unknown;
  try {
    if (text.trim() === "") value = {};
    else value = client === "codex" ? Bun.TOML.parse(text) : JSON.parse(text);
  } catch {
    return {
      ok: false,
      message:
        "The client config is malformed. Fix it and retry gw serve; the file was not replaced.",
    };
  }

  const parsed = object.safeParse(value);
  if (!parsed.success)
    return { ok: false, message: "The client config must contain an object; it was not replaced." };

  const key = client === "codex" ? "mcp_servers" : "mcpServers";
  const servers = object.safeParse(parsed.data[key] ?? {});
  if (!servers.success)
    return { ok: false, message: "The client MCP server map is malformed; it was not replaced." };

  const existing = object.safeParse(servers.data[name] ?? {});
  if (!existing.success)
    return {
      ok: false,
      message: "The gateway registration is malformed; the client config was not replaced.",
    };

  const headerKey = client === "codex" ? "http_headers" : "headers";
  const headers = z.record(z.string(), z.string()).safeParse(existing.data[headerKey] ?? {});
  if (!headers.success)
    return {
      ok: false,
      message: "The gateway headers are malformed; the client config was not replaced.",
    };

  const server = { ...existing.data };
  for (const field of [
    "command",
    "args",
    "env",
    "bearer_token_env_var",
    "env_http_headers",
    "http_headers_helper",
    "headersHelper",
  ])
    delete server[field];

  server.url = url;
  if (client === "claude") server.type = "http";

  const preserved = Object.fromEntries(
    Object.entries(headers.data).filter(([key]) => key.toLowerCase() !== "authorization"),
  );

  server[headerKey] = { ...preserved, Authorization: `Bearer ${token}` };
  if (isDeepStrictEqual(server, existing.data)) return { ok: true, value: text };

  const updated = { ...parsed.data, [key]: { ...servers.data, [name]: server } };
  if (client === "claude") return { ok: true, value: JSON.stringify(updated, null, 2) + "\n" };

  return editToml(text, server, updated);
}

function editToml(
  text: string,
  server: Record<string, unknown>,
  expected: Record<string, unknown>,
): Result<string> {
  // Bun supplies semantic parsing/serialization; source ranges preserve all
  // unrelated TOML text, including comments, multiline strings, and quoted keys.
  let ast: ReturnType<typeof parseTOML>;
  try {
    ast = parseTOML(text);
  } catch (cause) {
    if (!(cause instanceof ParseError)) throw cause;

    return {
      ok: false,
      message: "Could not safely parse the client TOML for editing. The config was not replaced.",
    };
  }

  const removed: Array<[number, number]> = [];
  let entireMap = false;
  for (const node of ast.body[0].body) {
    if (
      node.type === "TOMLTable" &&
      node.resolvedKey[0] === "mcp_servers" &&
      node.resolvedKey[1] === name
    ) {
      removed.push(node.range);
      continue;
    }

    const prefix = node.type === "TOMLTable" ? node.resolvedKey : [];
    const entries = node.type === "TOMLTable" ? node.body : [node];
    for (const entry of entries) {
      const keys = [
        ...prefix,
        ...entry.key.keys.map((key) => (key.type === "TOMLBare" ? key.name : key.value)),
      ];

      if (keys[0] !== "mcp_servers") continue;

      if (keys.length === 1) entireMap = true;

      if (keys.length === 1 || keys[1] === name) removed.push(entry.range);
    }
  }

  let result = text;
  for (const [start, end] of removed.sort((a, b) => b[0] - a[0]))
    result = result.slice(0, start) + result.slice(end);

  const replacement = entireMap
    ? { mcp_servers: expected.mcp_servers }
    : { mcp_servers: { [name]: server } };

  result = result.trimEnd() + "\n\n" + Bun.TOML.stringify(replacement) + "\n";
  let actual: unknown;
  try {
    actual = Bun.TOML.parse(result);
  } catch {
    return {
      ok: false,
      message: "Could not safely serialize the client TOML settings. The config was not replaced.",
    };
  }

  if (!isDeepStrictEqual(actual, expected))
    return {
      ok: false,
      message: "Could not preserve the client TOML settings. The config was not replaced.",
    };

  return { ok: true, value: result };
}

async function read(path: string): Promise<Result<Snapshot | undefined>> {
  const metadata = await info(path);
  if (metadata === undefined) return { ok: true, value: undefined };

  if (!metadata.isFile() || (process.getuid !== undefined && metadata.uid !== process.getuid()))
    return {
      ok: false,
      message: "The native client config must be a user-owned regular file, not a symlink.",
    };

  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (process.getuid !== undefined && stat.uid !== process.getuid()))
      return {
        ok: false,
        message: "The native client config changed ownership during registration.",
      };

    return {
      ok: true,
      value: { text: await file.readFile("utf8"), ino: stat.ino, dev: stat.dev, mode: stat.mode },
    };
  } finally {
    await file.close();
  }
}

async function info(path: string) {
  try {
    return await lstat(path);
  } catch (cause) {
    if (isCode(cause, ["ENOENT"])) return undefined;

    throw cause;
  }
}

async function closestDirectory(path: string): Promise<string> {
  if ((await info(path)) !== undefined) return path;

  return closestDirectory(dirname(resolve(path)));
}

function isCode(cause: unknown, codes: string[]) {
  return (
    cause instanceof Error &&
    "code" in cause &&
    typeof cause.code === "string" &&
    codes.includes(cause.code)
  );
}
