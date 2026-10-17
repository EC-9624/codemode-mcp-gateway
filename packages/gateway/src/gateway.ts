import {
  CodeExecutor,
  ToolCatalog,
  ToolResult,
  createDiscoveryTools,
  type ExecuteOptions,
  type SandboxTool,
  type ToolDefinition,
  type ToolException,
} from "@codemode-mcp-gateway/codemode";
import { createCodemodeServer } from "@codemode-mcp-gateway/mcp";
import { type McpServer } from "@modelcontextprotocol/server";
import { type Configuration } from "./config.ts";
import { Upstream, type ConnectionSnapshot, type ServerStatus } from "./upstream.ts";
import { executionInstructions } from "./instructions.ts";
import { OutputFiles } from "./output.ts";
import { GatewayError } from "./errors.ts";
import { type CredentialOptions } from "./auth/login.ts";
import { toolDefinitions } from "./catalog.ts";

export { type ServerStatus } from "./upstream.ts";

export type GatewayOptions = CredentialOptions & {
  signal?: AbortSignal;
  /** Receives controlled public status only. Exceptions remain host infrastructure failures. */
  onStatus?: (status: ServerStatus) => void;
  /** Receives original tool failure causes for host diagnostics; agents see only public messages. */
  onToolException?: (exception: ToolException) => void;
};

/**
 * Shares upstream connections and execution limits across MCP sessions,
 * rather than creating a separate pool for each client.
 */
export class Gateway implements AsyncDisposable {
  private readonly shutdown = new AbortController();
  private readonly upstreams: Upstream[];
  private readonly executor: CodeExecutor;
  private readonly servers = new Set<McpServer>();
  private readonly failed = Promise.withResolvers<unknown>();
  private fatal: { cause: unknown } | undefined;
  private cached:
    | { tools: Readonly<Record<string, SandboxTool>>; connections: ConnectionSnapshot[] }
    | undefined;
  private starting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private maintenance: Promise<void> | undefined;
  private readonly abort = () => this.shutdown.abort();

  constructor(
    config: Configuration,
    directory: string,
    private readonly options: GatewayOptions = {},
  ) {
    const snapshot = structuredClone(config);
    const onToolException = options.onToolException;
    this.executor = new CodeExecutor({
      ...snapshot.sandbox,
      ...(onToolException === undefined ? {} : { onToolException }),
    });

    this.upstreams = Object.entries(snapshot.mcp.servers).map(
      ([name, entry]) =>
        new Upstream(name, entry, directory, this.shutdown.signal, options, {
          changed: () => {
            this.cached = undefined;
          },
          status: (status) => options.onStatus?.(status),
          failed: (cause) => this.fail(cause),
        }),
    );
    options.signal?.addEventListener("abort", this.abort, { once: true });
    if (options.signal?.aborted) this.abort();
  }

  /** One bounded initial attempt per enabled server. Expected failures remain in status(). */
  start(): Promise<void> {
    if (this.starting === undefined && this.shutdown.signal.aborted)
      return Promise.reject(new GatewayError("Gateway is closed."));

    // Publish the single-flight promise before status callbacks can reenter start().
    this.starting ??= Promise.resolve().then(() => this.initialize());

    return this.starting;
  }

  /** Background infrastructure failures are also rethrown by close(). */
  get failure(): Promise<unknown> {
    return this.failed.promise;
  }

  status(): ServerStatus[] {
    return this.upstreams.map((upstream) => upstream.status());
  }

  /** All MCP instances share connections and execution admission. */
  createServer(): McpServer {
    if (this.shutdown.signal.aborted) throw new GatewayError("Gateway is closed.");

    const output = new OutputFiles();

    const server = createCodemodeServer({
      execute: (code, options) => this.execute(code, options),
      description: executionInstructions,
      formatOutput: (text) => output.format(text, (error) => server.server.onerror?.(error)),
      onClose: async () => {
        try {
          await output.close();
        } finally {
          this.servers.delete(server);
        }
      },
    });

    this.servers.add(server);

    return server;
  }

  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(() => this.dispose());
    this.shutdown.abort();

    return this.closing;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  private async initialize() {
    if (this.shutdown.signal.aborted) return;

    const results = await Promise.allSettled(this.upstreams.map((upstream) => upstream.start()));
    for (const result of results) {
      if (result.status === "rejected") {
        this.fail(result.reason);
        throw result.reason;
      }
    }

    if (this.fatal !== undefined) throw this.fatal.cause;

    if (this.shutdown.signal.aborted) return;

    this.timer = setInterval(() => {
      if (this.maintenance !== undefined) return;

      this.maintenance = this.recover()
        .catch((cause) => this.fail(cause))
        .finally(() => {
          this.maintenance = undefined;
        });
    }, 1000);
    this.timer.unref();
  }

  private async recover() {
    const results = await Promise.allSettled(this.upstreams.map((upstream) => upstream.recover()));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }

  private snapshot() {
    if (this.cached !== undefined) return this.cached;

    const definitions: Array<[string, ToolDefinition]> = [];
    const connections: ConnectionSnapshot[] = [];
    for (const upstream of this.upstreams) {
      const connection = upstream.snapshot();
      if (connection === undefined) continue;

      connections.push(connection);
      for (const [name, definition] of toolDefinitions(connection.catalog))
        definitions.push([`${upstream.name}.${name}`, definition]);
    }

    const catalog = ToolCatalog.create(Object.fromEntries(definitions));
    const discovery = createDiscoveryTools(catalog);
    const statuses = this.status();

    const tools: Readonly<Record<string, SandboxTool>> = {
      ...catalog.tools,
      ...discovery,
      searchTools: (args) => {
        let selected = discovery;
        let servers = statuses;
        if (
          typeof args === "object" &&
          args !== null &&
          "server" in args &&
          args.server !== undefined
        ) {
          if (typeof args.server !== "string")
            return ToolResult.failure("searchTools server must be a server name string.");

          const name = args.server;
          servers = statuses.filter((status) => status.name === name);
          if (servers.length === 0) return ToolResult.failure("Unknown server in this gateway.");

          // Filtering ranked matches before pagination preserves server-local offsets.
          selected = createDiscoveryTools({
            ...catalog,
            search: (query) =>
              catalog.search(query).filter((tool) => tool.name.startsWith(`${name}.`)),
          });
        }

        const result = selected.searchTools(args);
        if (!result.ok) return result;

        return ToolResult.success({ ...result.value, servers });
      },
    };

    this.cached = { tools, connections };

    return this.cached;
  }

  private async execute(code: string, options?: ExecuteOptions) {
    if (this.shutdown.signal.aborted) throw new GatewayError("Gateway is closed.");

    const snapshot = this.snapshot();
    // Recovery may replace connections mid-execution. Retain this revision until executor cleanup.
    for (const connection of snapshot.connections) connection.retain();

    try {
      return await this.executor.execute(code, {
        tools: snapshot.tools,
        signal: AbortSignal.any([
          this.shutdown.signal,
          ...(options?.signal === undefined ? [] : [options.signal]),
        ]),
      });
    } finally {
      for (const connection of snapshot.connections) connection.release();
    }
  }

  private fail(cause: unknown) {
    this.fatal ??= { cause };
    this.failed.resolve(cause);
    this.shutdown.abort();
  }

  private async dispose() {
    this.shutdown.abort();
    this.options.signal?.removeEventListener("abort", this.abort);
    if (this.timer !== undefined) clearInterval(this.timer);

    const errors: unknown[] = [];
    // Drain execution and presentation before retiring connections or deleting session output.
    const results = await Promise.allSettled([...this.servers].map((server) => server.close()));
    for (const result of results) if (result.status === "rejected") errors.push(result.reason);

    const attempts = await Promise.allSettled([
      ...(this.starting === undefined ? [] : [this.starting]),
      ...(this.maintenance === undefined ? [] : [this.maintenance]),
    ]);

    for (const result of attempts) if (result.status === "rejected") errors.push(result.reason);

    await Promise.all(this.upstreams.map((upstream) => upstream.close()));
    if (this.fatal !== undefined) errors.push(this.fatal.cause);

    if (errors.length > 0) throw new AggregateError(errors, "Gateway cleanup failed.");
  }
}
