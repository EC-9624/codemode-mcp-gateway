import { readConfiguration } from "../config.ts";
import {
  credentialStore,
  oauthConnection,
  type CredentialStore,
  type OAuthConnection,
} from "./credentials.ts";
import { acquireLease } from "./lease.ts";
import { authorize, isInvalidClient, oauthFailure } from "./oauth.ts";
import { AuthResult } from "./result.ts";
import { isDeepStrictEqual } from "node:util";

/** Hosts may inject a scoped store; production CLI commands use the OS credential service. */
export type CredentialOptions = {
  store?: (connection: OAuthConnection) => CredentialStore;
  lockDirectory?: string;
};

export type LoginOptions = CredentialOptions & {
  signal?: AbortSignal;
  /** Receives only an authorization URL, never tokens or the PKCE verifier. */
  authorize?: (url: URL) => Promise<void>;
  /** Deadline for lock acquisition, discovery, browser waiting, and token exchange. */
  timeoutMs?: number;
};

/** Returns expected auth/storage failures; configuration, infrastructure, and cleanup failures may reject. */
export async function login(path: string, options: LoginOptions = {}): Promise<AuthResult<void>> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2 ** 31 - 1) {
    return AuthResult.failure(
      "invalid",
      "OAuth login timeout must be a positive timer-sized integer.",
    );
  }

  const config = await readConfiguration(path);
  const connection = oauthConnection(config.upstream);
  if (!connection.ok) return connection;

  using deadlineCleanup = new DisposableStack();

  const deadline = new AbortController();

  const timer = setTimeout(
    () => deadline.abort(new DOMException("OAuth login timed out.", "TimeoutError")),
    timeoutMs,
  );

  deadlineCleanup.defer(() => clearTimeout(timer));

  const signal = AbortSignal.any([
    deadline.signal,
    ...(options.signal === undefined ? [] : [options.signal]),
  ]);

  const store = (options.store ?? credentialStore)(connection.value);
  const prepared = await prepareLogin(connection.value, store, signal, options.lockDirectory);

  if (!prepared.ok) return signal.aborted ? oauthFailure(signal.reason, signal) : prepared;

  await using attempt = prepared.value;

  if (signal.aborted) return oauthFailure(signal.reason, signal);

  const cancelled = Promise.withResolvers<void>();
  const abort = () => cancelled.resolve();
  signal.addEventListener("abort", abort, { once: true });

  try {
    await Promise.race([(options.authorize ?? openBrowser)(attempt.url), cancelled.promise]);
  } catch (cause) {
    if (signal.aborted) return oauthFailure(cause, signal);

    return AuthResult.failure(
      "unavailable",
      "Could not present the OAuth authorization URL.",
      cause,
    );
  } finally {
    signal.removeEventListener("abort", abort);
  }

  if (signal.aborted) return oauthFailure(signal.reason, signal);

  const completed = await attempt.complete();
  if (!completed.ok && !isInvalidClient(completed.error.cause)) return completed;

  const acquired = await acquireLease(connection.value, options.lockDirectory, { signal });
  if (!acquired.ok) return signal.aborted ? oauthFailure(signal.reason, signal) : acquired;

  await using lease = acquired.value;

  const guarded = lease.guard(store);
  const current = await guarded.load();
  if (!current.ok) return current;

  if (signal.aborted) return oauthFailure(signal.reason, signal);

  if (!isDeepStrictEqual(current.value, attempt.previous)) {
    return AuthResult.failure(
      "required",
      "Credentials changed during sign-in. Run cmg login again to authorize the current connection.",
    );
  }

  if (!completed.ok) {
    const cleared = await guarded.clear();

    return cleared.ok ? completed : cleared;
  }

  return await guarded.save(completed.value);
}

/**
 * Removes local credentials only; it does not revoke the upstream's authorization grant.
 * Returns expected auth/storage failures; configuration, infrastructure, and cleanup failures may reject.
 */
export async function logout(
  path: string,
  options: CredentialOptions = {},
): Promise<AuthResult<void>> {
  const config = await readConfiguration(path);
  const connection = oauthConnection(config.upstream);
  if (!connection.ok) return connection;

  const lease = await acquireLease(connection.value, options.lockDirectory);
  if (!lease.ok) return lease;

  await using cleanup = new AsyncDisposableStack();

  cleanup.use(lease.value);
  const store = lease.value.guard((options.store ?? credentialStore)(connection.value));

  return await store.clear();
}

/** Registration changes are serialized, but browser consent never holds the credential lock. */
async function prepareLogin(
  connection: OAuthConnection,
  store: CredentialStore,
  signal: AbortSignal,
  directory: string | undefined,
) {
  const acquired = await acquireLease(connection, directory, { signal });
  if (!acquired.ok) return acquired;

  await using lease = acquired.value;

  const prepared = await authorize(
    connection,
    lease.guard(store),
    AbortSignal.any([signal, lease.signal]),
  );

  const held = lease.check();
  if (!held.ok) {
    if (prepared.ok) await prepared.value[Symbol.asyncDispose]();

    return held;
  }

  // The caller takes ownership of the listener only after lock release succeeds.
  try {
    await lease[Symbol.asyncDispose]();
  } catch (cause) {
    if (prepared.ok) await prepared.value[Symbol.asyncDispose]();

    throw cause;
  }

  return prepared;
}

async function openBrowser(url: URL): Promise<void> {
  console.error("Open this URL to authorize CMG:\n" + url.href);
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const child = Bun.spawn([command, url.href], {
      stdout: "ignore",
      stderr: "ignore",
      timeout: 5_000,
    });

    if ((await child.exited) === 0) return;
  } catch {
    // The displayed URL keeps login usable without a desktop/browser launcher.
  }

  console.error("Could not open a browser automatically. Open the URL above manually.");
}
