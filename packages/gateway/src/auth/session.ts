import {
  refreshAuthorization,
  type AuthProvider,
  type OAuthTokens,
} from "@modelcontextprotocol/client";
import {
  type Credentials,
  withTokens,
  type CredentialStore,
  type OAuthConnection,
  credentialVersion,
} from "./credentials.ts";
import { AuthResult, AuthorizationError, type AuthFailure } from "./result.ts";
import {
  authFetch,
  discoverOAuth,
  isInvalidClient,
  oauthFailure,
  type OAuthDiscovery,
} from "./oauth.ts";
import { acquireLease } from "./lease.ts";
import { isDeepStrictEqual } from "node:util";

/** Shares refresh work in-process; a short lease coordinates stored grants across processes. */
export class OAuthSession implements AsyncDisposable {
  private readonly shutdown = new AbortController();
  private readonly signal: AbortSignal;
  private pending: Promise<AuthResult<string>> | undefined;
  private terminal: AuthResult<never> | undefined;
  private readVersion = 0;
  private acceptedVersion = 0;
  private readonly challengedTokens = new WeakMap<Response, string>();

  private constructor(
    private readonly connection: OAuthConnection,
    private record: Credentials | undefined,
    private readonly discovery: OAuthDiscovery,
    private readonly store: CredentialStore,
    signal: AbortSignal,
    private readonly lockDirectory: string | undefined,
  ) {
    this.signal = AbortSignal.any([signal, this.shutdown.signal]);
  }

  static async open(
    connection: OAuthConnection,
    store: CredentialStore,
    signal: AbortSignal,
    lockDirectory?: string,
  ): Promise<AuthResult<OAuthSession>> {
    const stored = await store.load();
    if (!stored.ok) return stored;

    const record = stored.value;
    if (record === undefined || record.authorization.status === "required") {
      return AuthResult.failure(
        "required",
        "No upstream authorization is available. Run cmg login <configuration.json>.",
      );
    }

    if (record.upstreamUrl !== connection.url) {
      return AuthResult.failure("invalid", "Stored credentials belong to a different upstream.");
    }

    const discovered = await discoverOAuth(connection, signal);
    if (!discovered.ok) return discovered;

    if (
      record.issuer !== discovered.value.issuer ||
      record.resource !== discovered.value.resource
    ) {
      return AuthResult.failure(
        "required",
        "The upstream OAuth issuer or resource changed. Run cmg login <configuration.json>.",
      );
    }

    return AuthResult.success(
      new OAuthSession(connection, record, discovered.value, store, signal, lockDirectory),
    );
  }

  get provider(): AuthProvider {
    return {
      token: async () => {
        const result = await this.token();
        if (!result.ok) throw this.authorizationError(result.error);

        return result.value;
      },
      onUnauthorized: async ({ response }) => {
        const used = this.challengedTokens.get(response);
        const result = await this.token(true, used);
        if (!result.ok) throw this.authorizationError(result.error);
      },
    };
  }

  /** Associate a challenge with the token actually sent, not whichever token is current later. */
  observe(response: Response, headers: RequestInit["headers"]): void {
    if (response.status !== 401) return;

    const authorization = new Headers(headers).get("authorization");
    if (authorization?.startsWith("Bearer "))
      this.challengedTokens.set(response, authorization.slice(7));
  }

  private authorizationError(failure: AuthFailure): AuthorizationError {
    const record = this.record;

    const reopen =
      record !== undefined &&
      record.authorization.status === "authorized" &&
      (record.issuer !== this.discovery.issuer || record.resource !== this.discovery.resource);

    const version = credentialVersion(record);
    if (reopen) return new AuthorizationError(failure, version, "reopen");

    // Terminal failures may have consumed a rotating grant, even when their kind
    // resembles a retryable storage/network failure.
    if (this.terminal !== undefined) return new AuthorizationError(failure, version);

    return AuthorizationError.beforeExchange(failure, version);
  }

  async token(force = false, rejected?: string): Promise<AuthResult<string>> {
    if (this.pending !== undefined) return this.pending;

    // Reads need no lock: the store replaces complete snapshots. This notices login/logout elsewhere.
    const version = ++this.readVersion;
    const loaded = await this.store.load();
    if (!loaded.ok) return loaded;

    if (this.pending !== undefined) return this.pending;

    const checked = this.accept(loaded.value, version);
    if (!checked.ok) return checked;

    if (this.terminal !== undefined) return this.terminal;

    const authorization = checked.value.authorization;
    const expires = authorization.tokens.expires_in;
    if (
      (!force || (rejected !== undefined && rejected !== authorization.tokens.access_token)) &&
      (expires === undefined || Date.now() + 30_000 < authorization.receivedAt + expires * 1_000)
    ) {
      return AuthResult.success(authorization.tokens.access_token);
    }

    if (this.signal.aborted)
      return AuthResult.failure("cancelled", "OAuth operation was cancelled.");

    this.pending = this.refresh(authorization.tokens.access_token);
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.shutdown.abort();
    await this.pending;
  }

  private accept(loaded: Credentials | undefined, version: number) {
    // A read started earlier must not undo a newer snapshot or its terminal failure.
    const record = version < this.acceptedVersion ? this.record : loaded;
    this.acceptedVersion = Math.max(version, this.acceptedVersion);
    if (!isDeepStrictEqual(record, this.record)) this.terminal = undefined;

    this.record = record;
    if (record === undefined || record.authorization.status === "required") {
      return AuthResult.failure(
        "required",
        "Upstream authorization is required. Run cmg login <configuration.json>.",
      );
    }

    if (
      record.upstreamUrl !== this.connection.url ||
      record.issuer !== this.discovery.issuer ||
      record.resource !== this.discovery.resource
    ) {
      return AuthResult.failure(
        "required",
        "The upstream OAuth binding changed. A new connection is required.",
      );
    }

    return AuthResult.success({ ...record, authorization: record.authorization });
  }

  private async refresh(staleToken: string): Promise<AuthResult<string>> {
    const acquired = await acquireLease(this.connection, this.lockDirectory, {
      signal: this.signal,
    });

    if (!acquired.ok) return acquired;

    await using lease = acquired.value;

    const store = lease.guard(this.store);
    const version = ++this.readVersion;
    const loaded = await store.load();
    if (!loaded.ok) return loaded;

    const checked = this.accept(loaded.value, version);
    if (!checked.ok) return checked;

    if (this.terminal !== undefined) return this.terminal;

    const record = checked.value;
    const authorization = record.authorization;
    if (authorization.tokens.access_token !== staleToken) {
      return AuthResult.success(authorization.tokens.access_token);
    }

    if (authorization.tokens.refresh_token === undefined) {
      return AuthResult.failure(
        "required",
        "The upstream did not provide a usable refresh token. Run cmg login <configuration.json>.",
      );
    }

    let tokens: OAuthTokens;
    try {
      tokens = await refreshAuthorization(this.discovery.authorizationServerUrl, {
        metadata: this.discovery.metadata,
        clientInformation: record.client,
        refreshToken: authorization.tokens.refresh_token,
        ...(this.discovery.resource === null ? {} : { resource: this.discovery.resource }),
        fetchFn: authFetch(AbortSignal.any([this.signal, lease.signal])),
      });
    } catch (cause) {
      const held = lease.check();
      const failed = held.ok ? oauthFailure(cause, this.signal) : held;
      if (!failed.ok && failed.error.kind === "required") {
        const invalidated = {
          ...record,
          authorization: { status: "required" },
        } satisfies Credentials;

        const saved = isInvalidClient(cause) ? await store.clear() : await store.save(invalidated);

        if (saved.ok) this.record = invalidated;

        this.terminal = saved.ok ? failed : saved;

        return this.terminal;
      }

      // A lost response may already have rotated the grant; never retry it blindly.
      this.terminal = failed;

      return failed;
    }

    const updated = withTokens(record, tokens);
    if (!updated.ok) {
      this.terminal = updated;

      return updated;
    }

    // A received rotation must be committed even if the initiating execution was cancelled.
    const saved = await store.save(updated.value);
    if (!saved.ok) {
      this.terminal = saved;

      return saved;
    }

    this.record = updated.value;

    return AuthResult.success(updated.value.authorization.tokens.access_token);
  }
}
