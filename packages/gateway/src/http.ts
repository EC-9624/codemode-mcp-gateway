import { createHash, timingSafeEqual } from "node:crypto";
import {
  WebStandardStreamableHTTPServerTransport,
  type McpServer,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Gateway } from "./gateway.ts";
import { type ClientRegistration } from "./clients.ts";
import { ServiceAuthentication } from "./service-auth.ts";

const credential = z
  .string()
  .min(32)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

const baseOptions = z.strictObject({
  port: z.number().int().min(0).max(65535),
  orphanGraceMs: z.number().int().positive().default(60_000),
  configurationId: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

const optionsSchema = z.union([
  baseOptions.extend({ bearerToken: credential }),
  baseOptions.extend({ serviceKey: credential }),
]);

export type HttpOptions = z.input<typeof optionsSchema>;
export type HttpListenResult =
  | { ok: true; server: GatewayHttpServer }
  | {
      ok: false;
      error: { kind: "invalid-options" | "address-in-use" | "listen-failed"; message: string };
    };

type Session = {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  requests: number;
  lastActivity: number;
  closing?: Promise<void>;
};

/** Borrows the gateway; owns only the HTTP listener and its MCP sessions. */
export class GatewayHttpServer implements AsyncDisposable {
  readonly url: URL;
  readonly instanceId = crypto.randomUUID();
  private readonly listener: Bun.Server<undefined>;
  private readonly sessions = new Map<string, Session>();
  private readonly owned = new Set<Session>();
  private readonly retiring = new Set<Promise<void>>();
  private readonly tokenHash: Buffer;
  private readonly authentication: ServiceAuthentication | undefined;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly started = performance.now();
  private readonly configurationId: string | undefined;
  private clients: ClientRegistration[] = [];
  private closing: Promise<void> | undefined;
  private stopped = false;
  private readonly fault = Promise.withResolvers<unknown>();

  private constructor(
    private readonly gateway: Gateway,
    options: z.output<typeof optionsSchema>,
  ) {
    this.authentication =
      "serviceKey" in options ? new ServiceAuthentication(options.serviceKey) : undefined;
    this.tokenHash = digest(
      "serviceKey" in options
        ? ServiceAuthentication.bearer(options.serviceKey, this.instanceId)
        : options.bearerToken,
    );
    this.configurationId = options.configurationId;
    this.listener = Bun.serve({
      hostname: "127.0.0.1",
      port: options.port,
      // MCP event streams and executions can legitimately be quiet for longer
      // than Bun's default socket idle timeout. Gateway execution deadlines remain.
      idleTimeout: 0,
      fetch: (request) => this.handle(request),
      error: () => new Response("Internal server error", { status: 500 }),
    });
    this.url = new URL("/mcp", this.listener.url);
    this.timer = setInterval(
      () => {
        const now = performance.now();
        for (const session of this.owned) {
          if (session.requests === 0 && now - session.lastActivity >= options.orphanGraceMs) {
            void this.retire(session).catch((cause: unknown) => {
              this.fail(cause);
            });
          }
        }
      },
      Math.min(options.orphanGraceMs, 10_000),
    );
    this.timer.unref();
  }

  static async listen(gateway: Gateway, options: HttpOptions): Promise<HttpListenResult> {
    const parsed = optionsSchema.safeParse(options);
    if (!parsed.success)
      return {
        ok: false,
        error: {
          kind: "invalid-options",
          message:
            "Invalid HTTP options: use a valid port and a private bearer token of at least 32 characters.",
        },
      };

    try {
      return { ok: true, server: new GatewayHttpServer(gateway, parsed.data) };
    } catch (cause) {
      if (cause instanceof Error && "code" in cause) {
        if (cause.code === "EADDRINUSE")
          return {
            ok: false,
            error: {
              kind: "address-in-use",
              message: `Port ${parsed.data.port} is already in use. Stop the owning service or select a different service port.`,
            },
          };

        if (cause.code === "EACCES")
          return {
            ok: false,
            error: {
              kind: "listen-failed",
              message: "The operating system denied access to the service port.",
            },
          };
      }

      throw cause;
    }
  }

  /** Host infrastructure failures remain private and require shutting down this host. */
  get failure(): Promise<unknown> {
    return this.fault.promise;
  }

  /** CLI startup status only; the HTTP host itself never edits native client configs. */
  setClientRegistrations(results: ClientRegistration[]): void {
    this.clients = [...results];
  }

  close(): Promise<void> {
    this.stopped = true;
    this.closing ??= Promise.resolve().then(() => this.dispose());

    return this.closing;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("host") !== this.url.host)
      return new Response("Invalid host", { status: 403 });

    const origin = request.headers.get("origin");
    if (origin !== null && origin !== this.url.origin)
      return new Response("Origin not allowed", { status: 403 });

    if (url.pathname === "/health" && request.method === "GET") return new Response("ok");

    const authorization = request.headers.get("authorization");
    const submitted = authorization?.match(/^Bearer +([A-Za-z0-9_-]+)$/i)?.[1];

    const signed =
      url.pathname === "/status" &&
      request.method === "GET" &&
      this.authentication?.accepts(url, authorization) === true;

    if (
      !signed &&
      (submitted === undefined || !timingSafeEqual(digest(submitted), this.tokenHash))
    ) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="codemode-mcp-gateway"' },
      });
    }

    if (this.stopped) return new Response("Service is stopping", { status: 503 });

    if (url.pathname === "/status" && request.method === "GET") {
      const body = JSON.stringify({
        service: {
          ready: true,
          pid: process.pid,
          instanceId: this.instanceId,
          uptimeMs: Math.round(performance.now() - this.started),
          configurationId: this.configurationId,
        },
        sessions: this.sessions.size,
        upstreams: this.gateway.status(),
        clients: this.clients,
      });

      return new Response(body, {
        headers: {
          "content-type": "application/json",
          ...(signed && authorization !== null && this.authentication !== undefined
            ? { "x-cmg-status-signature": this.authentication.response(url, authorization, body) }
            : {}),
        },
      });
    }

    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });

    if (!["GET", "POST", "DELETE"].includes(request.method))
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "GET, POST, DELETE" },
      });

    const id = request.headers.get("mcp-session-id");
    if (id !== null) {
      const session = this.sessions.get(id);
      if (session === undefined || session.closing !== undefined)
        return rpcError(404, -32001, "Session not found");

      return this.dispatch(session, request);
    }

    if (request.method !== "POST") return rpcError(400, -32000, "Initialize an MCP session first");

    let body: unknown;
    try {
      body = await request.clone().json();
    } catch {
      return rpcError(400, -32700, "Invalid JSON request");
    }

    const message = z
      .object({ method: z.string(), id: z.union([z.string(), z.number(), z.null()]).optional() })
      .safeParse(body);

    if (!message.success) return rpcError(400, -32600, "Invalid MCP request");

    // An optional protocol probe must fail as a method, not tear down the client
    // before it has an opportunity to use the supported initialize handshake.
    if (message.data.method !== "initialize")
      return rpcError(200, -32601, "Method not found", message.data.id ?? null);

    if (this.stopped) return new Response("Service is stopping", { status: 503 });

    const server = this.gateway.createServer();

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId) => {
        this.sessions.set(sessionId, session);
      },
      onsessionclosed: () => this.retire(session),
    });

    const session: Session = { server, transport, requests: 0, lastActivity: performance.now() };
    this.owned.add(session);
    try {
      await server.connect(transport);
      if (this.stopped) {
        await this.retire(session);

        return new Response("Service is stopping", { status: 503 });
      }

      const onClose = transport.onclose;
      transport.onclose = () => {
        try {
          onClose?.();
        } finally {
          void this.retire(session).catch((cause: unknown) => {
            this.fail(cause);
          });
        }
      };

      const response = await this.dispatch(session, request);
      if (transport.sessionId === undefined) await this.retire(session);

      return response;
    } catch (cause) {
      this.fail(cause);
      await this.retire(session);

      return rpcError(500, -32603, "MCP session initialization failed");
    }
  }

  private async dispatch(session: Session, request: Request): Promise<Response> {
    session.requests++;
    let finished = false;

    const finish = () => {
      if (finished) return;

      finished = true;
      session.requests--;
      session.lastActivity = performance.now();
      request.signal.removeEventListener("abort", finish);
    };

    request.signal.addEventListener("abort", finish, { once: true });
    if (request.signal.aborted) finish();

    let response: Response;
    try {
      response = await session.transport.handleRequest(request);
    } catch (cause) {
      finish();
      this.fail(cause);

      return rpcError(500, -32603, "MCP request failed");
    }

    if (response.body === null) {
      finish();

      return response;
    }

    const reader = response.body.getReader();

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            finish();
            controller.close();

            return;
          }

          const value: unknown = chunk.value;
          if (!(value instanceof Uint8Array))
            throw new TypeError("Invalid MCP response stream chunk.");

          controller.enqueue(value);
        } catch (cause) {
          finish();
          controller.error(cause);
        }
      },
      async cancel(reason: unknown) {
        finish();
        await reader.cancel(reason);
      },
    });

    return new Response(body, { status: response.status, headers: response.headers });
  }

  private retire(session: Session): Promise<void> {
    session.closing ??= Promise.resolve().then(async () => {
      const id = session.transport.sessionId;
      if (id !== undefined) this.sessions.delete(id);

      try {
        await session.server.close();
      } finally {
        this.owned.delete(session);
      }
    });
    const closing = session.closing;
    this.retiring.add(closing);
    void closing.then(
      () => this.retiring.delete(closing),
      (cause: unknown) => {
        this.fail(cause);
      },
    );

    return closing;
  }

  private async dispose() {
    clearInterval(this.timer);
    const stopping = this.listener.stop(false);
    const pending = [...this.owned].map((session) => this.retire(session));
    const results = await Promise.allSettled(new Set([...pending, ...this.retiring]));
    await this.listener.stop(true);
    await stopping;

    const errors = results
      .filter((result) => result.status === "rejected")
      .map((result) => {
        const cause: unknown = result.reason;

        return cause;
      });

    if (errors.length > 0) throw new AggregateError(errors, "HTTP session cleanup failed.");
  }

  private fail(cause: unknown) {
    this.stopped = true;
    this.fault.resolve(cause);
  }
}

function digest(value: string) {
  return createHash("sha256").update(value).digest();
}

function rpcError(
  status: number,
  code: number,
  message: string,
  id: string | number | null = null,
) {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
}
