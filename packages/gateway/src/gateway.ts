import {
  CodeExecutor,
  ToolCatalog,
  ToolResult,
  createDiscoveryTools,
  type ExecuteOptions,
  type SandboxTool,
  type ToolDefinition,
} from "@cmg/codemode";
import { createCodemodeServer } from "@cmg/mcp";
import { type McpServer } from "@modelcontextprotocol/server";
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { type Configuration, type ServerConfiguration } from "./config.ts";
import { connectUpstream, UpstreamError } from "./upstream.ts";
import { executionDescription } from "./composition.ts";
import { GatewayError } from "./errors.ts";
import { AuthorizationError } from "./auth/result.ts";
import {
  credentialStore,
  credentialVersion,
  oauthConnection,
  type CredentialStore,
} from "./auth/credentials.ts";
import { type CredentialOptions } from "./auth/login.ts";

type PublicFailure = { kind: string; message: string };
export type ServerStatus = { name: string; updatedAt: string } & (
  | { state: "connected"; toolCount: number }
  | { state: "disabled" | "connecting"; toolCount: 0 }
  | { state: "needs-auth" | "failed"; toolCount: 0; error: PublicFailure }
);
type Connection = Awaited<ReturnType<typeof connectUpstream>>;
type Lease = { connection: Connection; users: number; retired: boolean; disposal?: Promise<void> };
type State =
  | { kind: "disabled" | "connecting" }
  | { kind: "connected"; lease: Lease }
  | { kind: "needs-auth"; error: PublicFailure }
  | { kind: "failed"; error: PublicFailure; retryAt: number };
type Entry = {
  name: string;
  config: ServerConfiguration;
  state: State;
  updatedAt: string;
  store: CredentialStore | undefined;
  version: string;
  attempt: number;
  failures: number;
};

export type GatewayOptions = CredentialOptions & {
  signal?: AbortSignal;
  /** Receives controlled public status only. Exceptions remain host infrastructure failures. */
  onStatus?: (status: ServerStatus) => void;
};

/** Owns upstream lifetimes and one executor, supplying a catalog snapshot for each execution. */
export class Gateway implements AsyncDisposable {
  private readonly config: Configuration;
  private readonly shutdown = new AbortController();
  private readonly entries: Entry[];
  private readonly executor: CodeExecutor;
  private readonly leases = new Set<Lease>();
  private readonly attempts = new Map<string, Promise<void>>();
  private readonly servers = new Set<McpServer>();
  private readonly failed = Promise.withResolvers<unknown>();
  private fatal: { cause: unknown } | undefined;
  private cached: { tools: Readonly<Record<string, SandboxTool>>; leases: Lease[] } | undefined;
  private starting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private maintenance: Promise<void> | undefined;
  private readonly abort = () => this.shutdown.abort();

  constructor(
    config: Configuration,
    private readonly directory: string,
    private readonly options: GatewayOptions = {},
  ) {
    this.config = structuredClone(config);
    this.executor = new CodeExecutor(this.config.sandbox);

    const configured =
      this.config.upstream === undefined
        ? this.config.mcp.servers
        : { default: { upstream: this.config.upstream, disabled: false } };

    this.entries = Object.entries(configured).map(([name, entry]) => {
      const oauth = oauthConnection(entry.upstream);

      return {
        name,
        config: entry,
        state: { kind: entry.disabled ? "disabled" : "connecting" },
        updatedAt: new Date().toISOString(),
        store: oauth.ok ? (options.store ?? credentialStore)(oauth.value) : undefined,
        version: credentialVersion(undefined),
        attempt: 0,
        failures: 0,
      };
    });
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
    return this.entries.map((entry) => this.describe(entry));
  }

  /** All MCP instances from this gateway share connections and execution admission. */
  createServer(): McpServer {
    if (this.shutdown.signal.aborted) throw new GatewayError("Gateway is closed.");

    const server = createCodemodeServer({
      execute: (code, options) => this.execute(code, options),
      description:
        executionDescription +
        "\nTool names are server-qualified (server.original-name). searchTools also accepts server to filter matches and returns a servers availability snapshot. Failed authentication reports the named login command; recovery updates subsequent executions.",
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

    for (const entry of this.entries) {
      if (entry.config.disabled) this.report(entry);
    }

    const results = await Promise.allSettled(
      this.entries.filter((entry) => !entry.config.disabled).map((entry) => this.connect(entry)),
    );

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

  private connect(entry: Entry): Promise<void> {
    const pending = this.attempts.get(entry.name);
    if (pending !== undefined) return pending;

    const attempt = Promise.resolve()
      .then(() => this.open(entry))
      .finally(() => {
        this.attempts.delete(entry.name);
      });

    this.attempts.set(entry.name, attempt);

    return attempt;
  }

  private async open(entry: Entry) {
    if (this.shutdown.signal.aborted) return;

    const attempt = ++entry.attempt;
    this.update(entry, { kind: "connecting" });
    let connection: Connection;
    try {
      if (entry.store !== undefined) {
        const loaded = await entry.store.load();
        if (!loaded.ok) throw AuthorizationError.beforeExchange(loaded.error);

        entry.version = credentialVersion(loaded.value);
      }

      this.shutdown.signal.throwIfAborted();
      const store = entry.store;
      connection = await connectUpstream(
        entry.config.upstream,
        this.directory,
        this.shutdown.signal,
        {
          ...this.options,
          ...(store === undefined ? {} : { store: () => store }),
        },
        {
          closed: () => {
            if (
              this.shutdown.signal.aborted ||
              entry.attempt !== attempt ||
              entry.state.kind !== "connected"
            )
              return;

            this.unavailable(entry, {
              kind: "connection",
              message:
                "Upstream connection closed or session expired; reconnection will be attempted automatically.",
            });
          },
          authentication: (error) => {
            // A pre-exchange read/lock failure leaves this session usable. Keeping
            // it also preserves any concurrent refresh's terminal-failure latch.
            if (error.recovery === "retry") return error.message;

            if (
              !this.shutdown.signal.aborted &&
              entry.attempt === attempt &&
              entry.state.kind === "connected"
            ) {
              this.authorizationFailed(entry, error);
            }

            return this.authMessage(entry, error);
          },
        },
      );
    } catch (cause) {
      if (isCancellation(cause, this.shutdown.signal)) return;

      // In particular, SuppressedError from setup disposal must survive shutdown.
      if (this.shutdown.signal.aborted) throw cause;

      if (cause instanceof AuthorizationError) {
        this.authorizationFailed(entry, cause);

        return;
      }

      if (cause instanceof GatewayError) {
        this.unavailable(entry, {
          kind: cause instanceof UpstreamError ? cause.stage : "connection",
          message: cause.message,
        });

        return;
      }

      throw cause;
    }

    if (this.shutdown.signal.aborted || !connection.connected) {
      await connection[Symbol.asyncDispose]();
      if (!this.shutdown.signal.aborted)
        this.unavailable(entry, {
          kind: "connection",
          message: "Upstream closed during discovery.",
        });

      return;
    }

    if (this.config.upstream !== undefined) {
      for (const name of Object.keys(createDiscoveryTools(connection.catalog))) {
        if (!Object.hasOwn(connection.catalog.tools, name)) continue;

        await connection[Symbol.asyncDispose]();
        this.unavailable(entry, {
          kind: "discovery",
          message: `Upstream tool ${JSON.stringify(name)} conflicts with a CMG discovery helper.`,
        });

        return;
      }
    }

    const lease: Lease = { connection, users: 0, retired: false };
    this.leases.add(lease);
    entry.failures = 0;
    this.update(entry, { kind: "connected", lease });
  }

  private async recover() {
    const results = await Promise.allSettled(
      this.entries.map(async (entry) => {
        if (this.shutdown.signal.aborted) return;

        if (entry.state.kind === "needs-auth" && entry.store !== undefined) {
          const loaded = await entry.store.load();
          if (!loaded.ok || loaded.value?.authorization.status !== "authorized") return;

          if (credentialVersion(loaded.value) === entry.version) return;

          await this.connect(entry);
        } else if (entry.state.kind === "failed" && Date.now() >= entry.state.retryAt) {
          await this.connect(entry);
        }
      }),
    );

    for (const result of results) if (result.status === "rejected") throw result.reason;
  }

  private unavailable(entry: Entry, error: PublicFailure) {
    const delay = Math.min(60_000, 5000 * 2 ** Math.min(entry.failures++, 4));
    this.update(entry, { kind: "failed", error, retryAt: Date.now() + delay });
  }

  private update(entry: Entry, state: State) {
    const previous = entry.state;
    entry.state = state;
    entry.updatedAt = new Date().toISOString();
    this.cached = undefined;
    if (previous.kind === "connected") {
      previous.lease.retired = true;
      this.release(previous.lease);
    }

    this.report(entry);
  }

  private report(entry: Entry) {
    try {
      this.options.onStatus?.(this.describe(entry));
    } catch (cause) {
      // A reporting callback can run on a transport event stack. Surface its failure
      // through the owner's failure/close channels instead of an uncaught event throw.
      this.fail(cause);
    }
  }

  private describe(entry: Entry): ServerStatus {
    const base = { name: entry.name, updatedAt: entry.updatedAt };
    const state = entry.state;
    if (state.kind === "connected")
      return {
        ...base,
        state: "connected",
        toolCount: Object.keys(state.lease.connection.catalog.tools).length,
      };

    if (state.kind === "needs-auth" || state.kind === "failed")
      return { ...base, state: state.kind, toolCount: 0, error: { ...state.error } };

    return { ...base, state: state.kind, toolCount: 0 };
  }

  private authorizationFailed(entry: Entry, cause: AuthorizationError) {
    if (cause.credentialVersion !== undefined) entry.version = cause.credentialVersion;

    const error = { kind: cause.failure.kind, message: this.authMessage(entry, cause) };
    if (cause.recovery === "retry") {
      this.unavailable(entry, error);

      return;
    }

    this.update(
      entry,
      cause.recovery === "reopen"
        ? { kind: "failed", error: { ...error, kind: "credentials-changed" }, retryAt: Date.now() }
        : { kind: "needs-auth", error },
    );
  }

  private authMessage(entry: Entry, cause: AuthorizationError): string {
    if (cause.recovery === "reopen")
      return `Server ${JSON.stringify(entry.name)} credentials changed; its connection is recovering automatically. Use a subsequent execution.`;

    if (cause.recovery === "retry")
      return `Server ${JSON.stringify(entry.name)} authorization ${cause.failure.kind}; reconnection will be attempted automatically.`;

    return `Server ${JSON.stringify(entry.name)} authorization ${cause.failure.kind}. Run cmg login --server ${entry.name} with the same configuration; recovery is automatic after credentials change.`;
  }

  private snapshot() {
    if (this.cached !== undefined) return this.cached;

    const definitions = new Map<string, ToolDefinition>();
    const leases: Lease[] = [];
    const groups = new Map<string, ToolCatalog>();
    for (const entry of this.entries) {
      const members = new Map<string, ToolDefinition>();
      if (entry.state.kind === "connected") {
        const lease = entry.state.lease;
        leases.push(lease);
        for (const [original, execute] of Object.entries(lease.connection.catalog.tools)) {
          const metadata = lease.connection.catalog.describe(original);
          if (metadata === undefined) throw new Error("Missing upstream catalog metadata.");

          const name = this.config.upstream === undefined ? `${entry.name}.${original}` : original;

          const definition = {
            description: metadata.description,
            ...(metadata.inputSchema === undefined ? {} : { inputSchema: metadata.inputSchema }),
            execute,
          };

          definitions.set(name, definition);
          members.set(name, definition);
        }
      }

      groups.set(entry.name, ToolCatalog.create(Object.fromEntries(members)));
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

          const group = groups.get(args.server);
          if (group === undefined) return ToolResult.failure("Unknown server in this gateway.");

          selected = createDiscoveryTools(group);
          servers = statuses.filter((status) => status.name === args.server);
        }

        const result = selected.searchTools(args);
        if (!result.ok) return result;

        // Discovery is an ordinary tool boundary; its successful page is validated by its owner.
        const page = result.value;
        if (typeof page !== "object" || page === null) throw new Error("Invalid discovery page.");

        return ToolResult.success({ ...page, servers });
      },
    };

    this.cached = { tools, leases };

    return this.cached;
  }

  private async execute(code: string, options?: ExecuteOptions) {
    if (this.shutdown.signal.aborted) throw new GatewayError("Gateway is closed.");

    const snapshot = this.snapshot();
    for (const lease of snapshot.leases) lease.users++;

    try {
      return await this.executor.execute(code, {
        tools: snapshot.tools,
        signal: AbortSignal.any([
          this.shutdown.signal,
          ...(options?.signal === undefined ? [] : [options.signal]),
        ]),
      });
    } finally {
      for (const lease of snapshot.leases) {
        lease.users--;
        this.release(lease);
      }
    }
  }

  private release(lease: Lease) {
    if (!lease.retired || lease.users !== 0 || lease.disposal !== undefined) return;

    lease.disposal = lease.connection[Symbol.asyncDispose]()
      .catch((cause) => this.fail(cause))
      .finally(() => this.leases.delete(lease));
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
    const results = await Promise.allSettled([...this.servers].map((server) => server.close()));
    for (const result of results) if (result.status === "rejected") errors.push(result.reason);

    const attempts = await Promise.allSettled([
      ...(this.starting === undefined ? [] : [this.starting]),
      ...this.attempts.values(),
      ...(this.maintenance === undefined ? [] : [this.maintenance]),
    ]);

    for (const result of attempts) if (result.status === "rejected") errors.push(result.reason);

    for (const lease of this.leases) {
      lease.retired = true;
      this.release(lease);
    }

    await Promise.all(
      [...this.leases].flatMap((lease) => (lease.disposal === undefined ? [] : [lease.disposal])),
    );
    if (this.fatal !== undefined) errors.push(this.fatal.cause);

    if (errors.length > 0) throw new AggregateError(errors, "Gateway cleanup failed.");
  }
}

function isCancellation(cause: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;

  if (cause === signal.reason) return true;

  if (cause instanceof AuthorizationError) return cause.failure.kind === "cancelled";

  if (cause instanceof UpstreamError)
    return (
      cause.cause === signal.reason ||
      (cause.cause instanceof SdkError && cause.cause.code === SdkErrorCode.RequestTimeout)
    );

  return false;
}
