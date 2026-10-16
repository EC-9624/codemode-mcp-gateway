import { randomBytes } from "node:crypto";
import {
  discoverOAuthServerInfo,
  extractWWWAuthenticateParams,
  registerClient,
  startAuthorization,
  exchangeAuthorization,
  validateAuthorizationResponseIssuer,
  OAuthError,
  OAuthErrorCode,
  type AuthorizationServerMetadata,
  type FetchLike,
} from "@modelcontextprotocol/client";
import {
  withTokens,
  Credentials,
  type CredentialStore,
  type OAuthConnection,
} from "./credentials.ts";
import { listenForCallback } from "./loopback.ts";
import { AuthResult, AuthorizationError } from "./result.ts";

export type OAuthDiscovery = {
  issuer: string;
  authorizationServerUrl: string;
  metadata: AuthorizationServerMetadata;
  resource: string | null;
  resourceScopes: string[] | undefined;
};

/** Prepare one browser authorization attempt. The caller owns it and saves its completed grant. */
export async function authorize(
  connection: OAuthConnection,
  store: CredentialStore,
  signal: AbortSignal,
) {
  const stored = await store.load();
  if (!stored.ok) return stored;

  const discovered = await discoverOAuth(connection, signal);
  if (!discovered.ok) return discovered;

  const discovery = discovered.value;
  const previous = stored.value;

  const scopes = new Set(
    connection.scope?.split(/\s+/).filter(Boolean) ?? discovery.resourceScopes ?? [],
  );

  if (
    discovery.resourceScopes?.includes("offline_access") ||
    discovery.metadata.scopes_supported?.includes("offline_access")
  )
    scopes.add("offline_access");

  // DCR defaults can differ from resource scopes. Register and request the same grant
  // so consent cannot be constrained by an incompatibly scoped client registration.
  const scope = scopes.size === 0 ? undefined : [...scopes].join(" ");

  const reusable =
    previous !== undefined &&
    previous.upstreamUrl === connection.url &&
    previous.issuer === discovery.issuer &&
    previous.resource === discovery.resource &&
    (previous.client.client_secret_expires_at === undefined ||
      previous.client.client_secret_expires_at === 0 ||
      previous.client.client_secret_expires_at * 1000 > Date.now());

  if (signal.aborted) return AuthResult.failure("cancelled", "OAuth login was cancelled.");

  await using setup = new AsyncDisposableStack();

  const port = callbackPort(reusable ? previous.redirectUri : undefined);
  if (!port.ok) return port;

  const state = randomBytes(32).toString("base64url");
  const callback = await listenForCallback(state, signal, port.value);

  if (!callback.ok) return callback;

  const listener = setup.use(callback.value);
  let client = reusable ? previous.client : undefined;
  if (client === undefined) {
    if (discovery.metadata.registration_endpoint === undefined) {
      return AuthResult.failure(
        "unsupported",
        "This OAuth server does not support dynamic registration. Pre-registered clients and client metadata documents are not implemented yet.",
      );
    }

    try {
      client = await registerClient(discovery.authorizationServerUrl, {
        metadata: discovery.metadata,
        clientMetadata: {
          client_name: "codemode-mcp-gateway",
          application_type: "native",
          redirect_uris: [listener.redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        },
        ...(scope === undefined ? {} : { scope }),
        fetchFn: authFetch(signal),
      });
    } catch (cause) {
      return oauthFailure(cause, signal);
    }
  }

  const parsed = Credentials.safeParse({
    version: 1,
    upstreamUrl: connection.url,
    issuer: discovery.issuer,
    resource: discovery.resource,
    redirectUri: listener.redirectUri,
    client,
    authorization: { status: "required" },
  } satisfies Credentials);

  if (!parsed.success) {
    return AuthResult.failure(
      "invalid",
      "The upstream returned unsupported or invalid OAuth client registration.",
    );
  }

  const record = parsed.data;

  // Keep new registration even if consent is denied; the next login can reuse its redirect URI.
  if (!reusable) {
    const saved = await store.save(record);
    if (!saved.ok) return saved;
  }

  let authorization;
  try {
    authorization = await startAuthorization(discovery.authorizationServerUrl, {
      metadata: discovery.metadata,
      clientInformation: record.client,
      redirectUrl: listener.redirectUri,
      state,
      ...(scope === undefined ? {} : { scope }),
      ...(discovery.resource === null ? {} : { resource: discovery.resource }),
    });
  } catch (cause) {
    return oauthFailure(cause, signal);
  }

  const verifier = authorization.codeVerifier;
  let completed: Promise<AuthResult<Credentials>> | undefined;
  const cleanup = setup.move();

  return AuthResult.success({
    url: authorization.authorizationUrl,
    /** Snapshot expected at commit; a concurrent logout/login/refresh must not be overwritten. */
    previous: reusable ? previous : record,
    // A code exchange must not be repeated, including after an uncertain failure.
    complete: () =>
      (completed ??= listener.response.then((response) =>
        response.ok
          ? exchangeCallback(record, discovery, verifier, response.value, signal)
          : response,
      )),
    [Symbol.asyncDispose]: () => cleanup.disposeAsync(),
  });
}

async function exchangeCallback(
  record: Credentials,
  discovery: OAuthDiscovery,
  verifier: string,
  callback: URL,
  signal: AbortSignal,
): Promise<AuthResult<Credentials>> {
  if (`${callback.origin}${callback.pathname}` !== record.redirectUri || callback.hash !== "") {
    return AuthResult.failure(
      "invalid",
      "The OAuth callback did not match the registered redirect URI.",
    );
  }

  const parameters = callback.searchParams;
  if ([...parameters.keys()].some((name) => parameters.getAll(name).length !== 1)) {
    return AuthResult.failure("invalid", "The OAuth callback contained duplicate parameters.");
  }

  const code = parameters.get("code");
  const error = parameters.get("error");
  if ((code !== null && error !== null) || code === "" || error === "") {
    return AuthResult.failure(
      "invalid",
      "The OAuth callback must contain one nonempty code or error.",
    );
  }

  try {
    validateAuthorizationResponseIssuer({
      iss: parameters.get("iss") ?? undefined,
      expectedIssuer: discovery.issuer,
      issParameterSupported:
        discovery.metadata.authorization_response_iss_parameter_supported === true,
    });
  } catch (cause) {
    return AuthResult.failure(
      "invalid",
      "The OAuth callback issuer did not match the authorization server.",
      cause,
    );
  }

  if (error !== null) {
    return AuthResult.failure(
      "denied",
      "OAuth authorization was denied. No tokens were exchanged.",
    );
  }

  if (code === null)
    return AuthResult.failure(
      "invalid",
      "The OAuth callback did not contain an authorization code.",
    );

  let tokens;
  try {
    tokens = await exchangeAuthorization(discovery.authorizationServerUrl, {
      metadata: discovery.metadata,
      clientInformation: record.client,
      authorizationCode: code,
      ...(parameters.has("iss") ? { iss: parameters.get("iss") ?? "" } : {}),
      codeVerifier: verifier,
      redirectUri: record.redirectUri,
      ...(discovery.resource === null ? {} : { resource: discovery.resource }),
      fetchFn: authFetch(signal),
    });
  } catch (cause) {
    return oauthFailure(cause, signal);
  }

  return withTokens(record, tokens);
}

function callbackPort(redirectUri: string | undefined): AuthResult<number> {
  if (redirectUri === undefined) return AuthResult.success(0);

  const redirect = URL.parse(redirectUri);
  if (
    redirect === null ||
    redirect.protocol !== "http:" ||
    redirect.hostname !== "127.0.0.1" ||
    redirect.pathname !== "/oauth/callback" ||
    redirect.search !== "" ||
    redirect.hash !== "" ||
    redirect.username !== "" ||
    redirect.password !== "" ||
    Number(redirect.port) < 1024
  ) {
    return AuthResult.failure(
      "invalid",
      "Stored OAuth callback URI is not a supported loopback callback.",
    );
  }

  return AuthResult.success(Number(redirect.port));
}

export async function discoverOAuth(
  connection: OAuthConnection,
  signal: AbortSignal,
): Promise<AuthResult<OAuthDiscovery>> {
  let discoveryFailure: AuthResult<never> | undefined;
  let info;
  try {
    const request = authFetch(signal);

    const fetchFn: FetchLike = async (url, init) => {
      let response: Response;
      try {
        response = await request(url, init);
      } catch (cause) {
        discoveryFailure = oauthFailure(cause, signal);
        throw cause;
      }

      if (response.status === 429 || response.status >= 500)
        discoveryFailure = AuthResult.failure(
          "unavailable",
          "OAuth discovery is temporarily unavailable.",
        );

      return response;
    };

    const response = await fetchFn(connection.url, { headers: { Accept: "text/event-stream" } });
    // A successful probe may open an SSE stream; discovery only needs the headers.
    await response.body?.cancel();

    const resourceMetadataUrl =
      response.status === 401
        ? extractWWWAuthenticateParams(response).resourceMetadataUrl
        : undefined;

    if (resourceMetadataUrl !== undefined && !secureEndpoint(resourceMetadataUrl)) {
      return AuthResult.failure(
        "invalid",
        "OAuth resource metadata URL must use HTTPS or loopback HTTP without embedded credentials.",
      );
    }

    info = await discoverOAuthServerInfo(connection.url, {
      fetchFn,
      ...(resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl }),
    });
  } catch (cause) {
    return oauthFailure(cause, signal);
  }

  // The SDK can fall back after failed resource discovery. An outage must not
  // masquerade as a changed resource binding or missing authorization metadata.
  if (discoveryFailure !== undefined) return discoveryFailure;

  const metadata = info.authorizationServerMetadata;
  if (metadata === undefined) {
    return AuthResult.failure(
      "invalid",
      "The upstream did not provide valid OAuth authorization-server metadata.",
    );
  }

  if (
    [metadata.authorization_endpoint, metadata.token_endpoint, metadata.registration_endpoint].some(
      (endpoint) => endpoint !== undefined && !secureEndpoint(endpoint),
    )
  ) {
    return AuthResult.failure(
      "invalid",
      "OAuth metadata contains an insecure authorization, registration, or token endpoint.",
    );
  }

  const resource = info.resourceMetadata?.resource ?? null;
  if (resource !== null) {
    const server = new URL(connection.url);
    const target = new URL(resource);
    const prefix = target.pathname.endsWith("/") ? target.pathname : target.pathname + "/";
    if (
      target.origin !== server.origin ||
      target.hash !== "" ||
      target.username !== "" ||
      target.password !== "" ||
      (target.pathname !== server.pathname && !server.pathname.startsWith(prefix))
    ) {
      return AuthResult.failure(
        "invalid",
        "OAuth resource metadata does not match the configured upstream.",
      );
    }
  }

  return AuthResult.success({
    issuer: metadata.issuer,
    authorizationServerUrl: info.authorizationServerUrl,
    metadata,
    resource,
    resourceScopes: info.resourceMetadata?.scopes_supported,
  });
}

/** OAuth requests have no resource-server headers and cannot redirect credentials. */
export function authFetch(signal: AbortSignal): FetchLike {
  return async (input, init) => {
    if (!secureEndpoint(input)) {
      throw new AuthorizationError({
        kind: "invalid",
        message: "OAuth endpoints must use HTTPS or loopback HTTP without embedded credentials.",
      });
    }

    const combined = AbortSignal.any([
      signal,
      AbortSignal.timeout(15_000),
      ...(init?.signal ? [init.signal] : []),
    ]);

    return fetch(input, { ...init, signal: combined, redirect: "error" });
  };
}

export function oauthFailure(cause: unknown, signal: AbortSignal): AuthResult<never> {
  if (cause instanceof AuthorizationError) return { ok: false, error: cause.failure };

  if (signal.aborted) {
    return AuthResult.failure(
      "cancelled",
      signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
        ? "OAuth login timed out. Run gw login again."
        : "OAuth operation was cancelled.",
      cause,
    );
  }

  if (
    isInvalidClient(cause) ||
    (cause instanceof OAuthError && cause.code === OAuthErrorCode.InvalidGrant)
  ) {
    return AuthResult.failure(
      "required",
      "Upstream authorization is no longer valid. Run gw login <configuration.json>.",
      cause,
    );
  }

  if (
    cause instanceof OAuthError &&
    (cause.code === OAuthErrorCode.AccessDenied || cause.code === OAuthErrorCode.InvalidScope)
  ) {
    return AuthResult.failure(
      "denied",
      "The upstream denied OAuth authorization or the requested scope.",
      cause,
    );
  }

  return AuthResult.failure(
    "unavailable",
    "The OAuth operation failed. Credentials and upstream error details were not displayed.",
    cause,
  );
}

export function isInvalidClient(cause: unknown): boolean {
  return (
    cause instanceof OAuthError &&
    (cause.code === OAuthErrorCode.InvalidClient ||
      cause.code === OAuthErrorCode.UnauthorizedClient)
  );
}

function secureEndpoint(input: string | URL): boolean {
  const value = typeof input === "string" ? input : input.href;
  if (!URL.canParse(value)) return false;

  const url = new URL(value);

  return (
    url.username === "" &&
    url.password === "" &&
    url.hash === "" &&
    (url.protocol === "https:" ||
      (url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))
  );
}
