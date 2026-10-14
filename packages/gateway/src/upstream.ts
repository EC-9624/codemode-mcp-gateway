import { resolve } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
  InsufficientScopeError,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ToolCatalog, ToolResult } from "@cmg/codemode";
import { createMcpCatalog } from "@cmg/mcp";
import { resolveHeaders, type Configuration } from "./config.ts";
import { credentialStore, oauthConnection } from "./auth/credentials.ts";
import { OAuthSession } from "./auth/session.ts";
import { AuthorizationError } from "./auth/result.ts";
import { GatewayError } from "./errors.ts";
import { type CredentialOptions } from "./auth/login.ts";

/** Owns one upstream connection, its catalog, and its OAuth session. */
export async function connectUpstream(
  upstream: Configuration["upstream"],
  directory: string,
  signal: AbortSignal,
  options: CredentialOptions = {},
) {
  // Partial setup failures await registered cleanup in reverse order before rejecting.
  await using setup = new AsyncDisposableStack();
  let session: OAuthSession | undefined;
  if (upstream.transport === "http" && upstream.auth !== undefined) {
    const connection = oauthConnection(upstream);
    if (!connection.ok) throw new AuthorizationError(connection.error);

    const opened = await OAuthSession.open(
      connection.value,
      (options.store ?? credentialStore)(connection.value),
      signal,
      options.lockDirectory,
    );

    if (!opened.ok) throw new AuthorizationError(opened.error);

    session = opened.value;
    setup.use(session);
  }

  const transport = createTransport(upstream, directory, session);
  const closed = Promise.withResolvers<void>();
  transport.onclose = () => closed.resolve();
  const client = new Client({ name: "codemode-mcp-gateway", version: "0.0.0" });
  const connecting = client.connect(transport, { signal, timeout: 5_000 });
  const spawned = transport instanceof StdioClientTransport && transport.pid !== null;
  setup.defer(async () => {
    if (spawned) await closed.promise;
  });
  setup.defer(() => transport.close());
  setup.defer(() => client.close());
  if (transport instanceof StreamableHTTPClientTransport) {
    setup.defer(async () => {
      try {
        await transport.terminateSession();
      } catch (cause) {
        // Logout or shutdown can prevent authenticating session deletion.
        if (
          cause instanceof AuthorizationError &&
          (cause.failure.kind === "required" ||
            (signal.aborted && cause.failure.kind === "cancelled"))
        )
          return;

        throw cause;
      }
    });
  }

  try {
    await connecting;
  } catch (cause) {
    if (cause instanceof AuthorizationError) throw cause;

    throw new GatewayError(
      "Could not connect to the upstream MCP server. Check its transport configuration and authentication.",
      { cause },
    );
  }

  let catalog: ToolCatalog;
  try {
    catalog = await createMcpCatalog(client, { signal });
  } catch (cause) {
    if (cause instanceof AuthorizationError) throw cause;

    throw new GatewayError(
      "Upstream tool discovery failed. Check the upstream server's diagnostics.",
      {
        cause,
      },
    );
  }

  if (session !== undefined) catalog = publicAuthFailures(catalog);

  // `move()` empties setup and transfers cleanup to the returned connection; otherwise
  // leaving this function would close the resources before the caller could use them.
  const cleanup = setup.move();

  return { catalog, [Symbol.asyncDispose]: () => cleanup.disposeAsync() };
}

function createTransport(
  upstream: Configuration["upstream"],
  directory: string,
  session: OAuthSession | undefined,
) {
  if (upstream.transport === "stdio") {
    return new StdioClientTransport({
      command: upstream.command,
      ...(upstream.args === undefined ? {} : { args: upstream.args }),
      ...(upstream.env === undefined ? {} : { env: upstream.env }),
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
      const timeout = init?.method === "DELETE" ? AbortSignal.timeout(5_000) : undefined;

      const signal =
        timeout === undefined
          ? init?.signal
          : AbortSignal.any([timeout, ...(init?.signal ? [init.signal] : [])]);

      const response = await fetch(url, { ...init, ...(signal === undefined ? {} : { signal }) });
      session?.observe(response, init?.headers);

      return response;
    },
  });
}

function publicAuthFailures(catalog: ToolCatalog): ToolCatalog {
  return ToolCatalog.create(
    Object.fromEntries(
      Object.entries(catalog.tools).map(([name, tool]) => {
        const description = catalog.describe(name);
        if (description === undefined)
          throw new Error("An upstream tool is missing catalog metadata.");

        return [
          name,
          {
            ...description,
            async execute(args, context) {
              try {
                return await tool(args, context);
              } catch (cause) {
                if (cause instanceof AuthorizationError) return ToolResult.failure(cause.message);

                if (cause instanceof InsufficientScopeError) {
                  return ToolResult.failure(
                    "The upstream denied this operation's scope. Use an account with permission and explicitly run cmg login if additional consent is required.",
                  );
                }

                throw cause;
              }
            },
          } satisfies Parameters<typeof ToolCatalog.create>[0][string],
        ];
      }),
    ),
  );
}
