import { constants, promises } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  credentialName,
  Credentials,
  type CredentialStore,
  type OAuthConnection,
} from "./credentials.ts";
import { AuthResult } from "./result.ts";

/**
 * Plaintext snapshots protected by owner-only filesystem permissions (inherited ACLs on Windows).
 * Construction does no I/O; relative directories fail on use. Reads never create files or cache tokens.
 * Atomic replacement prevents partial reads, not competing refreshes: callers still need the credential lease.
 */
export function fileCredentialStore(
  connection: OAuthConnection,
  options: { directory?: string } = {},
): CredentialStore {
  const location = credentialLocation(connection, options.directory);

  return {
    async load() {
      if (!location.ok) return location;

      const directory = await privateDirectory(location.value.directory, false);
      if (!directory.ok) return directory;

      if (!directory.value) return AuthResult.success(undefined);

      const opened = await openCredential(location.value.path);
      if (!opened.ok) return opened;

      if (opened.value === undefined) return AuthResult.success(undefined);

      let content: string;
      try {
        await using file = opened.value;
        content = await file.readFile("utf8");
      } catch (cause) {
        return AuthResult.failure("storage", "Could not read the OAuth credential file.", cause);
      }

      let input: unknown;
      try {
        input = JSON.parse(content);
      } catch (cause) {
        return AuthResult.failure(
          "invalid",
          "Stored OAuth credentials are invalid. Run gw auth logout, then gw auth login.",
          cause,
        );
      }

      const parsed = Credentials.safeParse(input);
      if (!parsed.success || parsed.data.upstreamUrl !== location.value.url)
        return AuthResult.failure(
          "invalid",
          "Stored OAuth credentials do not match this connection. Run gw auth logout, then gw auth login.",
        );

      return AuthResult.success(parsed.data);
    },
    async save(value) {
      if (!location.ok) return location;

      const parsed = Credentials.safeParse(value);
      if (!parsed.success || parsed.data.upstreamUrl !== location.value.url)
        return AuthResult.failure(
          "invalid",
          "Cannot store credentials for a different upstream connection.",
        );

      const directory = await privateDirectory(location.value.directory, true);
      if (!directory.ok) return directory;

      // Replacement must refuse an existing unsafe path just as load() does, even
      // though publishing the new snapshot uses rename rather than an in-place write.
      const opened = await openCredential(location.value.path);
      if (!opened.ok) return opened;

      const content = JSON.stringify(parsed.data) + "\n";
      try {
        await opened.value?.close();
        await writeSnapshot(location.value.path, content);
      } catch (cause) {
        return AuthResult.failure(
          "storage",
          "Could not save the OAuth credential file. Authorization may need to be repeated.",
          cause,
        );
      }

      return AuthResult.success(undefined);
    },
    async clear() {
      if (!location.ok) return location;

      const directory = await privateDirectory(location.value.directory, false);
      if (!directory.ok) return directory;

      if (!directory.value) return AuthResult.success(undefined);

      const opened = await openCredential(location.value.path);
      if (!opened.ok) return opened;

      if (opened.value === undefined) return AuthResult.success(undefined);

      try {
        await opened.value.close();
        await promises.unlink(location.value.path);
      } catch (cause) {
        if (!hasCode(cause, "ENOENT"))
          return AuthResult.failure(
            "storage",
            "Could not remove the OAuth credential file.",
            cause,
          );
      }

      return AuthResult.success(undefined);
    },
  };
}

function credentialLocation(connection: OAuthConnection, directory: string | undefined) {
  const xdg = process.env.XDG_STATE_HOME;
  if (directory !== undefined && !isAbsolute(directory))
    return AuthResult.failure(
      "invalid",
      "The OAuth credential directory must be an absolute path.",
    );

  if (directory === undefined && xdg !== undefined && xdg !== "" && !isAbsolute(xdg))
    return AuthResult.failure("invalid", "XDG_STATE_HOME must be an absolute path.");

  const url = URL.parse(connection.url);
  if (url === null)
    return AuthResult.failure("invalid", "The OAuth upstream URL must be absolute.");

  const root =
    directory === undefined
      ? join(xdg || join(homedir(), ".local", "state"), "codemode-mcp-gateway", "credentials")
      : resolve(directory);

  return AuthResult.success({
    directory: root,
    path: join(root, credentialName(connection) + ".json"),
    url: url.href,
  });
}

async function privateDirectory(path: string, create: boolean): Promise<AuthResult<boolean>> {
  try {
    if (create) await promises.mkdir(path, { recursive: true, mode: 0o700 });

    const info = await promises.lstat(path);
    if (
      !info.isDirectory() ||
      (process.platform !== "win32" &&
        ((info.mode & 0o777) !== 0o700 ||
          (process.getuid !== undefined && info.uid !== process.getuid())))
    )
      return AuthResult.failure(
        "storage",
        "The OAuth credential directory must be owned by this user, not symlinked, and have mode 0700.",
      );

    return AuthResult.success(true);
  } catch (cause) {
    if (!create && hasCode(cause, "ENOENT")) return AuthResult.success(false);

    return AuthResult.failure(
      "storage",
      "Could not access the private OAuth credential directory.",
      cause,
    );
  }
}

/** Transfers the opened handle only after validating it; missing is distinct from unreadable. */
async function openCredential(path: string) {
  let file;
  try {
    // Reject symlinks at open and avoid waiting on a FIFO before the regular-file check.
    file = await promises.open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return AuthResult.success(undefined);

    return AuthResult.failure(
      "storage",
      "Could not open the non-symlinked OAuth credential file.",
      cause,
    );
  }

  let accepted = false;
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      (process.platform !== "win32" &&
        ((info.mode & 0o777) !== 0o600 ||
          (process.getuid !== undefined && info.uid !== process.getuid())))
    )
      return AuthResult.failure(
        "storage",
        "The OAuth credential file must be a regular file owned by this user with mode 0600.",
      );

    accepted = true;

    return AuthResult.success(file);
  } catch (cause) {
    return AuthResult.failure("storage", "Could not inspect the OAuth credential file.", cause);
  } finally {
    if (!accepted) await file.close();
  }
}

async function writeSnapshot(path: string, content: string): Promise<void> {
  const temporary = path + "." + crypto.randomUUID() + ".tmp";
  const file = await promises.open(temporary, "wx", 0o600);
  try {
    // Close before replacement for Windows. Readers see only the old or new complete snapshot.
    {
      await using owned = file;
      await owned.writeFile(content, "utf8");
      await owned.sync();
    }

    await promises.rename(temporary, path);
  } finally {
    await promises.rm(temporary, { force: true });
  }
}

function hasCode(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}
