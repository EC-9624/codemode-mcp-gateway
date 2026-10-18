import { resolve } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
  InsufficientScopeError,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ToolCatalog, ToolResult } from "@codemode-mcp-gateway/codemode";
import { createMcpCatalog } from "@codemode-mcp-gateway/mcp";
import { resolveHeaders, type ServerConfiguration } from "./config.ts";
import { oauthConnection } from "./auth/credentials.ts";
import { fileCredentialStore } from "./auth/file-store.ts";
import { OAuthSession } from "./auth/session.ts";
import { AuthorizationError } from "./auth/result.ts";
import { GatewayError } from "./errors.ts";
import { type CredentialOptions } from "./auth/login.ts";
import { toolDefinitions } from "./catalog.ts";

export class UpstreamError extends GatewayError {
  constructor(
    readonly stage: "connect" | "discovery",
    message: string,
    cause: unknown,
  ) {
    super(message, { cause });
  }
}

type ConnectionEvents = {
  closed: () => void;
  authorization: {
    failed: (error: AuthorizationError) => void;
    message: (error: AuthorizationError) => string;
  };
};

/** Opens one connection; the returned disposable owns its catalog, transport, and OAuth session. */
export async function connectUpstream(
  name: string,
  upstream: ServerConfiguration,
  directory: string,
  signal: AbortSignal,
  options: CredentialOptions,
  events: ConnectionEvents,
) {
  // Partial setup failures await registered cleanup in reverse order before rejecting.
  await using setup = new AsyncDisposableStack();
  const recovery = events.authorization;
  const timeout = new AbortController();
  const handshake = AbortSignal.any([signal, timeout.signal]);
  let session: OAuthSession | undefined;
  let authorizationUnavailable = false;

  const authorizationFailed = (error: AuthorizationError) => {
    if (error.recovery !== "retry") authorizationUnavailable = true;

    recovery.failed(error);
  };

  if (upstream.type === "remote" && upstream.oauth) {
    const connection = oauthConnection(name, upstream);
    if (!connection.ok) throw new AuthorizationError(connection.error);

    const opened = await OAuthSession.open(
      connection.value,
      (options.store ?? fileCredentialStore)(connection.value),
      handshake,
      options.lockDirectory,
      authorizationFailed,
    );

    if (!opened.ok) throw AuthorizationError.beforeExchange(opened.error);

    session = opened.value;
    setup.use(session);
  }

  const closed = Promise.withResolvers<void>();
  let disconnected = false;
  let initialized = false;

  const timer = setTimeout(
    () => timeout.abort(new DOMException("Upstream handshake timed out.", "TimeoutError")),
    5_000,
  );

  setup.defer(() => clearTimeout(timer));

  const transport = createTransport(
    upstream,
    directory,
    session,
    () => (initialized ? undefined : handshake),
    () => {
      if (disconnected) return;

      disconnected = true;
      events.closed();
    },
  );

  transport.onclose = () => {
    disconnected = true;
    closed.resolve();
    events.closed();
  };

  const client = new Client({ name: "codemode-mcp-gateway", version: "0.0.0" });
  const connecting = client.connect(transport, { signal: handshake, timeout: 5_000 });
  const spawned = transport instanceof StdioClientTransport && transport.pid !== null;
  setup.defer(async () => {
    if (spawned) await closed.promise;
  });
  setup.defer(() => transport.close());
  setup.defer(() => client.close());
  if (transport instanceof StreamableHTTPClientTransport) {
    setup.defer(async () => {
      // A known unusable grant cannot authenticate session deletion. Local transport
      // cleanup must still finish without attempting an uncertain refresh again.
      if (authorizationUnavailable || disconnected) return;

      try {
        await transport.terminateSession();
      } catch (cause) {
        // Logout or shutdown can prevent authenticating session deletion.
        if (
          cause instanceof AuthorizationError &&
          (cause.recovery !== "retry" || (signal.aborted && cause.failure.kind === "cancelled"))
        )
          return;

        throw cause;
      }
    });
  }

  try {
    await connecting;
    handshake.throwIfAborted();
    initialized = true;
  } catch (cause) {
    if (cause instanceof AuthorizationError) {
      authorizationUnavailable = true;
      throw cause;
    }

    throw new UpstreamError(
      "connect",
      "Could not connect to the upstream MCP server. Check its transport configuration and authentication.",
      cause,
    );
  } finally {
    // The SDK may already have opened a long-lived SSE stream with this signal.
    // A successful handshake must disarm its timer without aborting that stream.
    clearTimeout(timer);
  }

  let catalog: ToolCatalog;
  try {
    catalog = await createMcpCatalog(client, { signal });
  } catch (cause) {
    if (cause instanceof AuthorizationError) {
      authorizationUnavailable = true;
      throw cause;
    }

    throw new UpstreamError(
      "discovery",
      "Upstream tool discovery failed. Check the upstream server's diagnostics.",
      cause,
    );
  }

  if (session !== undefined)
    catalog = publicAuthFailures(catalog, authorizationFailed, recovery.message);

  // `move()` empties setup and transfers cleanup to the returned connection; otherwise
  // leaving this function would close the resources before the caller could use them.
  const cleanup = setup.move();

  return {
    catalog,
    get credentialVersion() {
      return session?.version;
    },
    get connected() {
      return !disconnected;
    },
    [Symbol.asyncDispose]: () => cleanup.disposeAsync(),
  };
}

function createTransport(
  upstream: ServerConfiguration,
  directory: string,
  session: OAuthSession | undefined,
  connectionSignal: () => AbortSignal | undefined,
  invalidated: () => void,
) {
  if (upstream.type === "local") {
    return new StdioClientTransport({
      command: upstream.command[0],
      args: upstream.command.slice(1),
      ...(upstream.environment === undefined ? {} : { env: upstream.environment }),
      cwd: resolve(directory, upstream.cwd ?? "."),
      stderr: "inherit",
    });
  }

  const headers = resolveHeaders(upstream.headers);
  if (!headers.ok) throw new GatewayError(headers.message);

  return new StreamableHTTPClientTransport(new URL(upstream.url), {
    requestInit: { headers: headers.headers },
    ...(session === undefined ? {} : { authProvider: session.provider }),
    onInsufficientScope: "throw",
    fetch: async (url, init) => {
      // SDK notifications do not inherit connect's request signal. Bound the entire
      // handshake, but let authenticated DELETE use its own shutdown-independent budget.
      const deadline = init?.method === "DELETE" ? AbortSignal.timeout(5_000) : connectionSignal();

      const signal =
        deadline === undefined
          ? init?.signal
          : AbortSignal.any([deadline, ...(init?.signal ? [init.signal] : [])]);

      const response = await fetch(url, { ...init, ...(signal === undefined ? {} : { signal }) });
      session?.observe(response, init?.headers);
      // The SDK reports expired sessions as request failures without closing the
      // transport. Reinitialize on a later execution; never replay this request.
      if (
        response.status === 404 &&
        init?.method !== "DELETE" &&
        new Headers(init?.headers).has("mcp-session-id")
      )
        invalidated();

      return response;
    },
  });
}

function publicAuthFailures(
  catalog: ToolCatalog,
  failed: (error: AuthorizationError) => void,
  message: (error: AuthorizationError) => string,
): ToolCatalog {
  return ToolCatalog.create(
    Object.fromEntries(
      toolDefinitions(catalog).map(([name, definition]) => [
        name,
        {
          ...definition,
          async execute(args, context) {
            try {
              return await definition.execute(args, context);
            } catch (cause) {
              if (cause instanceof AuthorizationError) {
                failed(cause);

                return ToolResult.failure(message(cause));
              }

              if (cause instanceof InsufficientScopeError) {
                return ToolResult.failure(
                  "The upstream denied this operation's scope. Use an account with permission and explicitly run gw login if additional consent is required.",
                );
              }

              throw cause;
            }
          },
        } satisfies Parameters<typeof ToolCatalog.create>[0][string],
      ]),
    ),
  );
}
