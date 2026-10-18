import {
  CodeExecutor,
  ToolCatalog,
  type ExecuteOptions,
  type SandboxTool,
  type ToolDefinition,
  type ToolException,
  type ToolContext,
} from "@codemode-mcp-gateway/codemode";
import { createCodemodeServer } from "@codemode-mcp-gateway/mcp";
import { type McpServer } from "@modelcontextprotocol/server";
import { type Configuration } from "./config.ts";
import { Upstream, type ConnectionSnapshot, type ServerStatus } from "./upstream/upstream.ts";
import { executionInstructions } from "./instructions.ts";
import { OutputFiles } from "./output.ts";
import { GatewayError } from "./errors.ts";
import { type CredentialOptions } from "./auth/credentials.ts";
import { discoveryBindings, toolDefinitions } from "./catalog.ts";
import { type ToolList } from "./tool-list.ts";
import { type Logger } from "./observability/logger.ts";
import { ExecutionObservation } from "./observability/execution.ts";
import { type Telemetry } from "./observability/telemetry.ts";
import {
  type Transport,
  type SessionContext,
  type SessionCloseReason,
  type FailureType,
} from "./observability/events.ts";
import { reportServerError } from "./diagnostics.ts";

export { type ServerStatus } from "./upstream/upstream.ts";

export type GatewayOptions = CredentialOptions & {
  signal?: AbortSignal;
  /** Receives controlled public status only. Exceptions remain host infrastructure failures. */
  onStatus?: (status: ServerStatus) => void;
  /** Receives original tool failure causes for host diagnostics; agents see only public messages. */
  onToolException?: (exception: ToolException) => void;
  /** Borrowed local logger. Omitted disables structured events; generic protocol diagnostics remain. */
  logger?: Logger;
  /** Borrowed metrics/tracing providers. The caller owns flushing/shutdown. */
  telemetry?: Telemetry;
};

/**
 * Shares upstream connections and execution limits across MCP sessions,
 * rather than creating a separate pool for each client.
 */
export class Gateway implements AsyncDisposable {
  readonly instanceId: string;
  private readonly shutdown = new AbortController();
  private readonly upstreams: Upstream[];
  private readonly executor: CodeExecutor;
  private readonly servers = new Set<McpServer>();
  private readonly failed = Promise.withResolvers<unknown>();
  // Box the cause: `throw undefined` is a failure, not the absence of one.
  private fatal: { cause: unknown } | undefined;
  private cached:
    | {
        tools: Readonly<Record<string, SandboxTool>>;
        connections: ConnectionSnapshot[];
        owners: ReadonlyMap<string, Upstream>;
      }
    | undefined;
  private starting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private maintenance: Promise<void> | undefined;
  private readonly abort = () => this.shutdown.abort();
  private readonly reportedStates = new Map<string, ServerStatus["state"]>();
  private readonly unregisterTelemetry: (() => void) | undefined;

  constructor(
    config: Configuration,
    directory: string,
    private readonly options: GatewayOptions = {},
  ) {
    this.instanceId =
      options.telemetry?.resource["service.instance.id"] ??
      options.logger?.resource["service.instance.id"] ??
      crypto.randomUUID();
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
          status: (status) => {
            const previous = this.reportedStates.get(status.name);
            this.reportedStates.set(status.name, status.state);
            options.logger?.emit({
              name: "gw.upstream.state_changed",
              attributes: {
                "gw.upstream.name": status.name,
                "gw.upstream.state": status.state,
                "gw.upstream.tools": status.toolCount,
                ...(previous === undefined ? {} : { "gw.upstream.previous_state": previous }),
                ...("error" in status
                  ? { "error.type": upstreamErrorType(status.error.kind) }
                  : {}),
              },
            });
            options.onStatus?.(status);
          },
          failed: (cause) => this.fail(cause),
        }),
    );
    this.unregisterTelemetry = options.telemetry?.registerGateway(() => ({
      active: this.executor.activeExecutionCount,
      servers: this.status(),
    }));
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

  /** Read current metadata without connecting, refreshing discovery, or executing tools. */
  listTools(): ToolList {
    const tools: ToolList["tools"] = [];
    for (const upstream of this.upstreams) {
      const connection = upstream.snapshot();
      if (connection === undefined) continue;

      for (const [name, definition] of toolDefinitions(connection.catalog))
        tools.push({
          server: upstream.name,
          name: `${upstream.name}.${name}`,
          description: definition.description,
        });
    }

    return { tools, servers: this.status() };
  }

  /** All MCP instances share connections and execution admission. */
  createServer(
    options: { transport?: Transport; closeReason?: () => SessionCloseReason } = {},
  ): McpServer {
    if (this.shutdown.signal.aborted) throw new GatewayError("Gateway is closed.");

    const output = new OutputFiles();
    const started = performance.now();

    const session: SessionContext = {
      "gw.transport": options.transport ?? "embedded",
      "gw.session.id": crypto.randomUUID(),
    };

    const reportProtocolError = () => {
      if (this.options.logger === undefined) reportServerError();
      else
        this.options.logger.emit({
          name: "gw.protocol.failed",
          attributes: { ...session, "error.type": "mcp_protocol" },
        });
    };

    const server = createCodemodeServer({
      execute: (code, options) => this.execute(code, options, session),
      description: executionInstructions,
      formatOutput: (text) =>
        output.format(text, (error) => {
          this.options.logger?.emit({
            name: "gw.output.save_failed",
            attributes: { ...session, "error.type": "output_storage" },
          });
          if (this.options.logger === undefined || server.server.onerror !== reportProtocolError)
            server.server.onerror?.(error);
        }),
      onClose: async () => {
        try {
          await output.close();
        } finally {
          this.servers.delete(server);
          this.options.telemetry?.sessionChanged(session["gw.transport"], -1);
          this.options.logger?.emit({
            name: "gw.session.closed",
            attributes: {
              ...session,
              "gw.session.close_reason": this.shutdown.signal.aborted
                ? "shutdown"
                : (options.closeReason?.() ?? "client"),
              "gw.session.duration_ms": performance.now() - started,
            },
          });
        }
      },
    });

    this.servers.add(server);
    this.options.telemetry?.sessionChanged(session["gw.transport"], 1);
    server.server.onerror = reportProtocolError;
    this.options.logger?.emit({ name: "gw.session.opened", attributes: session });

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
    const owners = new Map<string, Upstream>();
    for (const upstream of this.upstreams) {
      const connection = upstream.snapshot();
      if (connection === undefined) continue;

      connections.push(connection);
      for (const [name, definition] of toolDefinitions(connection.catalog)) {
        definitions.push([`${upstream.name}.${name}`, definition]);
        owners.set(`${upstream.name}.${name}`, upstream);
      }
    }

    const catalog = ToolCatalog.create(Object.fromEntries(definitions));
    const tools = discoveryBindings(catalog, this.status());

    this.cached = { tools, connections, owners };

    return this.cached;
  }

  private async execute(
    code: string,
    options: ExecuteOptions | undefined,
    session: SessionContext,
  ) {
    if (this.shutdown.signal.aborted) throw new GatewayError("Gateway is closed.");

    const snapshot = this.snapshot();

    const observation =
      this.options.logger === undefined && this.options.telemetry === undefined
        ? undefined
        : new ExecutionObservation(this.options.logger, session, this.options.telemetry);

    const tools =
      this.options.telemetry === undefined || observation === undefined
        ? snapshot.tools
        : Object.fromEntries(
            Object.entries(snapshot.tools).map(([name, tool]) => {
              const owner = snapshot.owners.get(name);
              if (owner === undefined) return [name, tool] as const;

              return [
                name,
                (args: unknown, context: ToolContext) =>
                  observation.call(owner.name, owner.transport, name, tool, args, context),
              ] as const;
            }),
          );

    // Recovery may replace connections mid-execution. Retain this revision until executor cleanup.
    for (const connection of snapshot.connections) connection.retain();

    try {
      const report = await this.executor.execute(code, {
        tools,
        ...(observation === undefined
          ? {}
          : {
              onToolException: (exception: ToolException) => {
                observation.toolException(exception);
                this.options.onToolException?.(exception);
              },
              onAdmitted: () => observation.admitted(),
            }),
        signal: AbortSignal.any([
          this.shutdown.signal,
          ...(options?.signal === undefined ? [] : [options.signal]),
        ]),
      });

      observation?.finish(report);

      return report;
    } catch (cause) {
      observation?.failed(cause);
      throw cause;
    } finally {
      for (const connection of snapshot.connections) connection.release();
    }
  }

  private fail(cause: unknown) {
    if (this.fatal === undefined)
      this.options.logger?.emit({
        name: "gw.service.failed",
        attributes: { "gw.component": "gateway", "error.type": "infrastructure" },
      });

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

    this.unregisterTelemetry?.();
  }
}

function upstreamErrorType(kind: string): FailureType {
  switch (kind) {
    case "connect":
    case "discovery":
    case "connection":
    case "credentials-changed":
      return kind;
    default:
      return "upstream_authorization";
  }
}
