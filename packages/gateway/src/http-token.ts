import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { GatewayError } from "./errors.ts";

export const httpCredential = z
  .string()
  .min(32)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

/** Explicit environment settings take precedence, including invalid/empty values. Never provision on read. */
export async function httpToken(): Promise<string> {
  if (process.env.GW_HTTP_TOKEN !== undefined) return environmentToken();

  const saved = await readToken(tokenPath());
  if (saved !== undefined) return saved;

  throw new GatewayError("No HTTP token is configured. Run gw setup or set GW_HTTP_TOKEN.");
}

/** Only explicit setup may create a credential. Existing tokens are validated, never replaced. */
export async function prepareHttpToken(): Promise<
  { source: "environment" } | { source: "file"; path: string; created: boolean }
> {
  if (process.env.GW_HTTP_TOKEN !== undefined) {
    environmentToken();

    return { source: "environment" };
  }

  const path = tokenPath();
  if ((await readToken(path)) !== undefined) return { source: "file", path, created: false };

  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  } catch (cause) {
    throw new GatewayError("Could not create the private HTTP token directory.", { cause });
  }

  await privateDirectory(dirname(path));
  const pending = join(dirname(path), `.token-${crypto.randomUUID()}`);
  let file;
  try {
    file = await open(pending, "wx", 0o600);
  } catch (cause) {
    throw new GatewayError("Could not create the private HTTP token file.", { cause });
  }

  await using owned = file;
  let created = true;
  try {
    try {
      await owned.writeFile(randomBytes(32).toString("hex") + "\n");
      await owned.sync();
    } catch (cause) {
      throw new GatewayError("Could not write the private HTTP token.", { cause });
    }

    try {
      // Publish complete bytes without replacing a concurrent setup's credential.
      await link(pending, path);
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "EEXIST")
        throw new GatewayError("Could not save the private HTTP token.", { cause });

      created = false;
    }
  } finally {
    await rm(pending, { force: true });
  }

  if ((await readToken(path)) === undefined)
    throw new GatewayError("The HTTP token disappeared during setup. Run gw setup again.");

  return { source: "file", path, created };
}

function tokenPath(): string {
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg !== undefined && xdg !== "" && !isAbsolute(xdg))
    throw new GatewayError("XDG_STATE_HOME must be an absolute path.");

  return join(xdg || join(homedir(), ".local/state"), "codemode-mcp-gateway/token");
}

function environmentToken(): string {
  const parsed = httpCredential.safeParse(process.env.GW_HTTP_TOKEN);
  if (!parsed.success)
    throw new GatewayError(
      "GW_HTTP_TOKEN must contain 32–256 letters, digits, underscores, or hyphens. Unset it to use the setup-created token file.",
    );

  return parsed.data;
}

async function privateDirectory(path: string): Promise<boolean> {
  let info;
  try {
    info = await lstat(path);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;

    throw new GatewayError("Could not inspect the HTTP token directory.", { cause });
  }

  if (
    !info.isDirectory() ||
    (info.mode & 0o777) !== 0o700 ||
    (process.getuid !== undefined && info.uid !== process.getuid())
  )
    throw new GatewayError(
      "The HTTP token directory must be owned by this user, not symlinked, and have mode 0700.",
    );

  return true;
}

async function readToken(path: string): Promise<string | undefined> {
  if (!(await privateDirectory(dirname(path)))) return undefined;

  let file;
  try {
    // Reject symlinks at open and avoid waiting on a FIFO before the regular-file check.
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;

    throw new GatewayError(
      "Could not open the HTTP token file. It must be a readable, non-symlinked private file.",
      { cause },
    );
  }

  await using owned = file;
  const info = await owned.stat();
  if (
    !info.isFile() ||
    (info.mode & 0o777) !== 0o600 ||
    (process.getuid !== undefined && info.uid !== process.getuid())
  )
    throw new GatewayError(
      "The HTTP token file must be a regular file owned by this user with mode 0600.",
    );

  // Allow a 256-byte ASCII token plus CRLF; reject oversized files before reading them.
  if (info.size > 258)
    throw new GatewayError(
      "The HTTP token file is invalid. It must contain one private token of 32–256 letters, digits, underscores, or hyphens.",
    );

  const parsed = httpCredential.safeParse((await owned.readFile("utf8")).trim());
  if (!parsed.success)
    throw new GatewayError(
      "The HTTP token file is invalid. It must contain one private token of 32–256 letters, digits, underscores, or hyphens.",
    );

  return parsed.data;
}
