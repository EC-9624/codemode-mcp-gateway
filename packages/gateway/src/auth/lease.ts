import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { credentialName, type CredentialStore, type OAuthConnection } from "./credentials.ts";
import { AuthResult, AuthorizationError } from "./result.ts";

export type CredentialLease = AsyncDisposable & {
  /** Aborted only when ownership is lost, not when an individual caller cancels. */
  signal: AbortSignal;
  check(): AuthResult<void>;
  guard(store: CredentialStore): CredentialStore;
};

/** Short credential-operation lock. All processes use the same stale/heartbeat policy. */
export async function acquireLease(
  connection: OAuthConnection,
  directory?: string,
  options: { signal?: AbortSignal; waitMs?: number } = {},
): Promise<AuthResult<CredentialLease>> {
  const xdg = process.env.XDG_STATE_HOME;
  if (directory === undefined && xdg !== undefined && xdg !== "" && !isAbsolute(xdg))
    return AuthResult.failure("invalid", "XDG_STATE_HOME must be an absolute path.");

  const path =
    directory ?? join(xdg || join(homedir(), ".local", "state"), "codemode-mcp-gateway", "locks");

  const lost = new AbortController();
  const deadline = performance.now() + (options.waitMs ?? 25_000);
  let release: (() => Promise<void>) | undefined;

  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await stat(path);
    if (
      !info.isDirectory() ||
      (process.getuid !== undefined && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))
    ) {
      return AuthResult.failure(
        "invalid",
        "The OAuth lock directory must be owned by this user and have mode 0700.",
      );
    }

    // proper-lockfile installs exit cleanup. Load it only when an operation needs a lock.
    const { lock } = await import("proper-lockfile");
    while (release === undefined) {
      if (options.signal?.aborted)
        return AuthResult.failure("cancelled", "OAuth lock acquisition was cancelled.");

      try {
        release = await lock(join(path, credentialName(connection) + ".credentials"), {
          // This is a lock marker, not an existing credential file to resolve.
          realpath: false,
          stale: 20_000,
          update: 1_000,
          // The outer loop owns the deadline and cancellable waits.
          retries: 0,
          onCompromised: (cause) =>
            lost.abort(
              new AuthorizationError({
                kind: "busy",
                message:
                  "OAuth credential lock was lost. The credential operation was stopped; retry the operation.",
                cause,
              }),
            ),
        });
      } catch (cause) {
        if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ELOCKED")
          throw cause;

        const remaining = deadline - performance.now();
        if (remaining <= 0)
          return AuthResult.failure(
            "busy",
            "Timed out waiting for another OAuth credential operation. Retry the operation.",
          );

        await setTimeout(Math.min(100, remaining), undefined, { signal: options.signal });
      }
    }
  } catch (cause) {
    if (options.signal?.aborted)
      return AuthResult.failure("cancelled", "OAuth lock acquisition was cancelled.", cause);

    return AuthResult.failure("unavailable", "Could not acquire the OAuth credential lock.", cause);
  }

  let disposed = false;

  const check = (): AuthResult<void> => {
    if (lost.signal.aborted && lost.signal.reason instanceof AuthorizationError) {
      return { ok: false, error: lost.signal.reason.failure };
    }

    if (disposed) return AuthResult.failure("cancelled", "OAuth credential operation has ended.");

    return AuthResult.success(undefined);
  };

  // Ownership may be lost during an awaited store operation. Report that loss even
  // if the operation succeeds; this check cannot cancel or roll back the store write.
  async function guarded<T>(operation: () => Promise<AuthResult<T>>): Promise<AuthResult<T>> {
    const before = check();
    if (!before.ok) return before;

    const result = await operation();
    const after = check();

    return after.ok ? result : after;
  }

  const unlock = release;

  return AuthResult.success({
    signal: lost.signal,
    check,
    guard: (store) => ({
      load: () => guarded(() => store.load()),
      save: (value) => guarded(() => store.save(value)),
      clear: () => guarded(() => store.clear()),
    }),
    async [Symbol.asyncDispose]() {
      if (disposed) return;

      disposed = true;
      // The library has already released compromised ownership; never remove a successor's lock.
      if (lost.signal.aborted) return;

      try {
        await unlock();
      } catch (cause) {
        throw new AuthorizationError({
          kind: "unavailable",
          message: "Could not release the OAuth credential lock.",
          cause,
        });
      }
    },
  });
}
