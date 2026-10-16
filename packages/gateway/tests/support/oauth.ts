import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { createMcpServer } from "../fixtures/mcp-tools.ts";
import { type CredentialStore, type Credentials } from "codemode-mcp-gateway";

export function memoryCredentials(initial?: Credentials) {
  let record = initial;
  let writes = 0;

  const store = {
    async load() {
      return { ok: true, value: structuredClone(record) };
    },
    async save(value) {
      record = structuredClone(value);
      writes++;

      return { ok: true, value: undefined };
    },
    async clear() {
      record = undefined;

      return { ok: true, value: undefined };
    },
  } satisfies CredentialStore;

  return {
    store,
    get record() {
      return record;
    },
    get writes() {
      return writes;
    },
  };
}

/** Real SDK HTTP transport with a small OAuth server; every credential is synthetic. */
export async function oauthFixture(
  options: {
    auth?: (request: Request) => Promise<Response | undefined>;
    refresh?: (fields: URLSearchParams) => Promise<Response | undefined>;
    deny?: boolean;
    challenge?: boolean;
    challengeScope?: string;
    resourceScopes?: readonly string[];
    authorizationScopes?: readonly string[];
    mcp?: (request: Request) => Promise<Response | undefined>;
    unauthorized?: (request: Request) => void | Promise<void>;
  } = {},
) {
  await using setup = new AsyncDisposableStack();

  const lockDirectory = await mkdtemp(join(tmpdir(), "cmg-oauth-locks-"));
  setup.defer(() => rm(lockDirectory, { recursive: true, force: true }));
  const sessions = setup.use(new AsyncDisposableStack());
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  let redirectUri = "";
  let challenge = "";
  let generation = 0;
  let refreshes = 0;
  let exchanges = 0;
  let registrations = 0;
  const registrationScopes: unknown[] = [];
  let rejectAccess = false;
  const requests: { path: string; headers: Headers; method: string }[] = [];

  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      requests.push({ path: url.pathname, headers: request.headers, method: request.method });
      if (url.pathname !== "/mcp") {
        const intercepted = await options.auth?.(request);
        if (intercepted !== undefined) return intercepted;
      }

      if (
        url.pathname === "/metadata" ||
        url.pathname.startsWith("/.well-known/oauth-protected-resource")
      ) {
        return Response.json({
          resource: new URL("/mcp", listener.url).href,
          authorization_servers: [listener.url.href],
          ...(options.resourceScopes === undefined
            ? {}
            : { scopes_supported: options.resourceScopes }),
        });
      }

      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: listener.url.href,
          authorization_endpoint: new URL("/authorize", listener.url).href,
          token_endpoint: new URL("/token", listener.url).href,
          registration_endpoint: new URL("/register", listener.url).href,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          authorization_response_iss_parameter_supported: true,
          scopes_supported: options.authorizationScopes ?? ["read", "write", "offline_access"],
        });
      }

      if (url.pathname === "/register") {
        const body: unknown = await request.json();
        if (
          typeof body !== "object" ||
          body === null ||
          !("redirect_uris" in body) ||
          !Array.isArray(body.redirect_uris) ||
          typeof body.redirect_uris[0] !== "string"
        ) {
          return Response.json({ error: "invalid_client_metadata" }, { status: 400 });
        }

        redirectUri = body.redirect_uris[0];
        registrations++;
        registrationScopes.push("scope" in body ? body.scope : undefined);

        return Response.json({ ...body, client_id: "cmg-test-client" }, { status: 201 });
      }

      if (url.pathname === "/authorize") {
        challenge = url.searchParams.get("code_challenge") ?? "";
        const callback = new URL(url.searchParams.get("redirect_uri") ?? redirectUri);
        callback.searchParams.set("state", url.searchParams.get("state") ?? "");
        callback.searchParams.set("iss", listener.url.href);
        callback.searchParams.set(
          options.deny ? "error" : "code",
          options.deny ? "access_denied" : "synthetic-code",
        );

        return Response.redirect(callback.href, 302);
      }

      if (url.pathname === "/token") {
        const fields = new URLSearchParams(await request.text());
        if (fields.get("grant_type") === "authorization_code") {
          exchanges++;
          const verifier = fields.get("code_verifier") ?? "";
          if (
            fields.get("code") !== "synthetic-code" ||
            fields.get("redirect_uri") !== redirectUri ||
            createHash("sha256").update(verifier).digest("base64url") !== challenge
          ) {
            return Response.json(
              { error: "invalid_grant", error_description: "private PKCE detail" },
              { status: 400 },
            );
          }
        } else {
          refreshes++;
          const intercepted = await options.refresh?.(fields);
          if (intercepted !== undefined) return intercepted;

          if (fields.get("refresh_token") !== `refresh-${generation}`) {
            return Response.json(
              { error: "invalid_grant", error_description: "private refresh detail" },
              { status: 400 },
            );
          }
        }

        generation++;
        rejectAccess = false;

        return Response.json({
          access_token: `access-${generation}`,
          refresh_token: `refresh-${generation}`,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "read",
        });
      }

      if (url.pathname === "/mcp") {
        if (
          rejectAccess ||
          request.headers.get("authorization") !== `Bearer access-${generation}`
        ) {
          await options.unauthorized?.(request);

          if (options.challenge === false) return new Response(null, { status: 405 });

          return new Response("private resource detail", {
            status: 401,
            headers: {
              "WWW-Authenticate": `Bearer resource_metadata="${new URL("/metadata", listener.url).href}"${options.challengeScope === undefined ? "" : `, scope="${options.challengeScope}"`}`,
            },
          });
        }

        const intercepted = await options.mcp?.(request);
        if (intercepted !== undefined) return intercepted;

        const id = request.headers.get("mcp-session-id");
        if (id !== null) {
          const transport = transports.get(id);

          return transport === undefined
            ? new Response("Unknown session", { status: 404 })
            : transport.handleRequest(request);
        }

        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            transports.set(id, transport);
          },
        });

        const server = createMcpServer();
        sessions.defer(() => server.close());
        await server.connect(transport);

        return transport.handleRequest(request);
      }

      return new Response("Not found", { status: 404 });
    },
  });

  setup.defer(() => listener.stop(true));
  const cleanup = setup.move();

  return {
    lockDirectory,
    url: new URL("/mcp", listener.url).href,
    issuer: listener.url.href,
    requests,
    registrationScopes,
    get refreshes() {
      return refreshes;
    },
    get exchanges() {
      return exchanges;
    },
    get registrations() {
      return registrations;
    },
    rejectAccess() {
      rejectAccess = true;
    },
    async authorize(url: URL) {
      const response = await fetch(url, { redirect: "manual" });
      const location = response.headers.get("location");
      if (location === null) throw new Error("Missing synthetic callback");

      return new URL(location);
    },
    credentials(receivedAt = Date.now()): Credentials {
      return {
        version: 1,
        upstreamUrl: new URL("/mcp", listener.url).href,
        issuer: listener.url.href,
        resource: new URL("/mcp", listener.url).href,
        redirectUri: "http://127.0.0.1:49152/oauth/callback",
        client: { client_id: "cmg-test-client" },
        authorization: {
          status: "authorized",
          receivedAt,
          tokens: {
            access_token: `access-${generation}`,
            refresh_token: `refresh-${generation}`,
            token_type: "Bearer",
            expires_in: 3600,
          },
        },
      };
    },
    [Symbol.asyncDispose]: () => cleanup.disposeAsync(),
  };
}
