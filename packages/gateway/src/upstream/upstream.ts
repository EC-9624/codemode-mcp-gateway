import { type ToolCatalog } from "@codemode-mcp-gateway/codemode";
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { z } from "zod";
import { type ServerConfiguration } from "../config.ts";
import { connectUpstream, UpstreamError, type ConnectionAuth } from "./connection.ts";
import { GatewayError } from "../errors.ts";
import { AuthorizationError } from "../auth/result.ts";
import { credentialVersion, oauthConnection, type CredentialOptions } from "../auth/credentials.ts";
import { fileCredentialStore } from "../auth/file-store.ts";
import { type Telemetry, type SpanObservation } from "../observability/telemetry.ts";

const statusBase = { name: z.string(), updatedAt: z.string() };
const publicFailure = z.object({ kind: z.string(), message: z.string() });
export const ServerStatus = z.discriminatedUnion("state", [
  z.object({
    ...statusBase,
    state: z.literal("connected"),
    toolCount: z.number().int().nonnegative(),
  }),
  z.object({ ...statusBase, state: z.enum(["disabled", "connecting"]), toolCount: z.literal(0) }),
  z.object({
    ...statusBase,
    state: z.enum(["needs-auth", "failed"]),
    toolCount: z.literal(0),
    error: publicFailure,
  }),
]);
export type ServerStatus = z.infer<typeof ServerStatus>;
type PublicFailure = z.infer<typeof publicFailure>;
type Connection = Awaited<ReturnType<typeof connectUpstream>>;
type Lease = { connection: Connection; users: number; retired: boolean; disposal?: Promise<void> };
type State =
  | { kind: "disabled" | "connecting" }
  | { kind: "connected"; lease: Lease }
  | { kind: "needs-auth"; error: PublicFailure }
  | { kind: "failed"; error: PublicFailure; retryAt: number };

/** A catalog revision can outlive recovery. Retain it through executor cleanup, then release it. */
export type ConnectionSnapshot = {
  catalog: ToolCatalog;
  retain(): void;
  release(): void;
};

/**
 * Keeps retired connections alive while executions still use their catalogs,
 * so recovery does not close resources those executions need.
 */
export class Upstream {
  readonly transport: "http" | "stdio";
  private state: State;
  private updatedAt = new Date().toISOString();
  private readonly auth: ConnectionAuth;
  private version = credentialVersion(undefined);
  private readonly blocked = new Map<string, AuthorizationError>();
  private attempt = 0;
  private failures = 0;
  private readonly leases = new Set<Lease>();

  constructor(
    readonly name: string,
    private readonly config: ServerConfiguration,
    private readonly directory: string,
    private readonly signal: AbortSignal,
    private readonly options: CredentialOptions & { telemetry?: Telemetry },
    private readonly events: {
      changed: () => void;
      status: (status: ServerStatus) => void;
      failed: (cause: unknown) => void;
    },
  ) {
    this.transport = config.type === "local" ? "stdio" : "http";
    this.state = { kind: config.disabled ? "disabled" : "connecting" };
    const oauth = oauthConnection(name, config);
    this.auth = oauth.ok
      ? {
          kind: "oauth",
          connection: oauth.value,
          store: (options.store ?? fileCredentialStore)(oauth.value),
          lockDirectory: options.lockDirectory,
        }
      : { kind: "none" };
  }

  start(trigger: "initial" | "recovery" = "initial"): Promise<void> {
    if (this.config.disabled) {
      this.report();

      return Promise.resolve();
    }

    // Gateway serializes startup and recovery passes; no separate attempt registry is needed.
    return Promise.resolve().then(() => this.open(trigger));
  }

  status(): ServerStatus {
    const base = { name: this.name, updatedAt: this.updatedAt };
    const state = this.state;
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

  snapshot(): ConnectionSnapshot | undefined {
    if (this.state.kind !== "connected") return undefined;

    const lease = this.state.lease;

    return {
      catalog: lease.connection.catalog,
      retain: () => lease.users++,
      release: () => {
        lease.users--;
        this.release(lease);
      },
    };
  }

  async recover(): Promise<void> {
    if (this.signal.aborted) return;

    if (this.state.kind === "needs-auth" && this.auth.kind === "oauth") {
      const loaded = await this.auth.store.load();
      if (!loaded.ok || loaded.value?.authorization.status !== "authorized") return;

      if (credentialVersion(loaded.value) === this.version) return;

      await this.start("recovery");
    } else if (this.state.kind === "failed" && Date.now() >= this.state.retryAt) {
      await this.start("recovery");
    }
  }

  /** The gateway aborts and drains start/recover and all execution snapshots before closing. */
  async close(): Promise<void> {
    for (const lease of this.leases) {
      lease.retired = true;
      this.release(lease);
    }

    await Promise.all(
      [...this.leases].flatMap((lease) => (lease.disposal === undefined ? [] : [lease.disposal])),
    );
  }

  private async open(trigger: "initial" | "recovery") {
    if (this.signal.aborted) return;

    const started = performance.now();

    const attributes = {
      "gw.upstream.name": this.name,
      "gw.upstream.transport": this.transport,
      "gw.upstream.connection.trigger": trigger,
    };

    const operation = this.options.telemetry?.startSpan("gw.upstream.connect", attributes);
    let failure: "infrastructure_error" | undefined;
    try {
      await this.connect(operation);
    } catch (cause) {
      failure = "infrastructure_error";
      throw cause;
    } finally {
      const observed = this.signal.aborted ? "cancelled" : this.state.kind;
      const outcome = failure ?? observed;
      this.options.telemetry?.connectionFinished(
        this.name,
        this.transport,
        trigger,
        outcome,
        performance.now() - started,
      );
      operation?.end(
        { "gw.upstream.connection.outcome": outcome },
        outcome !== "connected" && outcome !== "cancelled",
      );
    }
  }

  private async connect(operation: SpanObservation | undefined) {
    if (this.signal.aborted) return;

    const attempt = ++this.attempt;
    this.update({ kind: "connecting" });
    let connection: Connection;
    try {
      const auth = this.auth;
      if (auth.kind === "oauth") {
        const loaded = await auth.store.load();
        if (!loaded.ok) throw AuthorizationError.beforeExchange(loaded.error);

        this.version = credentialVersion(loaded.value);
        const blocked = this.blocked.get(this.version);
        if (blocked !== undefined) throw blocked;
      }

      this.signal.throwIfAborted();
      const blocked = this.blocked;

      // Old leased connections may invalidate a grant while its replacement is opening.
      const guarded: ConnectionAuth =
        auth.kind === "none"
          ? auth
          : {
              ...auth,
              store: {
                async load() {
                  const loaded = await auth.store.load();
                  if (loaded.ok) {
                    const failure = blocked.get(credentialVersion(loaded.value));
                    if (failure !== undefined) throw failure;
                  }

                  return loaded;
                },
                save: (value) => auth.store.save(value),
                clear: () => auth.store.clear(),
              },
            };

      connection = await connectUpstream(this.config, this.directory, this.signal, guarded, {
        response: (context, isError) => this.options.telemetry?.toolResponse(context, isError),
        phase: (phase) => {
          const span = this.options.telemetry?.startSpan(
            phase === "initialize" ? "gw.upstream.initialize" : "gw.upstream.discovery",
            { "gw.upstream.name": this.name },
            operation,
          );

          return {
            end: (failed: boolean) => {
              const observed = failed ? "failure" : "success";
              const outcome = this.signal.aborted ? "cancelled" : observed;
              span?.end({ "gw.upstream.phase.outcome": outcome }, failed && !this.signal.aborted);
            },
          };
        },
        closed: () => {
          if (this.signal.aborted || this.attempt !== attempt || this.state.kind !== "connected")
            return;

          this.unavailable({
            kind: "connection",
            message:
              "Upstream connection closed or session expired; reconnection will be attempted automatically.",
          });
        },
        authorization: {
          failed: (error) => {
            // A pre-exchange failure leaves this session and its refresh latch usable.
            if (error.recovery === "retry") return;

            if (!this.signal.aborted) this.authorizationFailed(error, attempt);
          },
          message: (error) =>
            error.recovery === "retry" ? error.message : this.authMessage(error),
        },
      });
    } catch (cause) {
      if (isCancellation(cause, this.signal)) return;

      // SuppressedError from setup disposal must survive shutdown.
      if (this.signal.aborted) throw cause;

      if (cause instanceof AuthorizationError) {
        this.authorizationFailed(cause);

        return;
      }

      if (cause instanceof GatewayError) {
        this.unavailable({
          kind: cause instanceof UpstreamError ? cause.stage : "connection",
          message: cause.message,
        });

        return;
      }

      throw cause;
    }

    if (this.signal.aborted || !connection.connected) {
      await connection[Symbol.asyncDispose]();
      if (!this.signal.aborted)
        this.unavailable({ kind: "connection", message: "Upstream closed during discovery." });

      return;
    }

    const version = connection.credentialVersion;
    const blocked = version === undefined ? undefined : this.blocked.get(version);
    if (blocked !== undefined) {
      await connection[Symbol.asyncDispose]();
      this.authorizationFailed(blocked);

      return;
    }

    const lease: Lease = { connection, users: 0, retired: false };
    this.leases.add(lease);
    if (version !== undefined) this.version = version;

    this.failures = 0;
    this.update({ kind: "connected", lease });
  }

  private unavailable(error: PublicFailure) {
    const delay = Math.min(60_000, 5000 * 2 ** Math.min(this.failures++, 4));
    this.update({ kind: "failed", error, retryAt: Date.now() + delay });
  }

  private update(state: State) {
    const previous = this.state;
    this.state = state;
    this.updatedAt = new Date().toISOString();
    this.events.changed();
    if (previous.kind === "connected") {
      previous.lease.retired = true;
      this.release(previous.lease);
    }

    this.report();
  }

  private report() {
    try {
      this.events.status(this.status());
    } catch (cause) {
      // Status may be reported on a transport event stack; use the owner's failure channel.
      this.events.failed(cause);
    }
  }

  private authorizationFailed(cause: AuthorizationError, attempt = this.attempt) {
    if (cause.recovery === "login" && cause.credentialVersion !== undefined)
      this.blocked.set(cause.credentialVersion, cause);

    if (attempt !== this.attempt) {
      // Retired sessions can block a replacement's grant, but cannot invalidate a newer one.
      const invalidatesCurrentGrant =
        cause.recovery === "login" &&
        cause.credentialVersion !== undefined &&
        this.state.kind === "connected" &&
        this.state.lease.connection.credentialVersion === cause.credentialVersion;

      if (!invalidatesCurrentGrant) return;
    }

    if (cause.credentialVersion !== undefined) this.version = cause.credentialVersion;

    const error = { kind: cause.failure.kind, message: this.authMessage(cause) };
    if (cause.recovery === "retry") {
      this.unavailable(error);

      return;
    }

    this.update(
      cause.recovery === "reopen"
        ? { kind: "failed", error: { ...error, kind: "credentials-changed" }, retryAt: Date.now() }
        : { kind: "needs-auth", error },
    );
  }

  private authMessage(cause: AuthorizationError): string {
    if (cause.recovery === "reopen")
      return `Server ${JSON.stringify(this.name)} credentials changed; its connection is recovering automatically. Use a subsequent execution.`;

    if (cause.recovery === "retry")
      return `Server ${JSON.stringify(this.name)} authorization ${cause.failure.kind}; reconnection will be attempted automatically.`;

    return `Server ${JSON.stringify(this.name)} authorization ${cause.failure.kind}. Run gw auth login -- ${this.name} with the same configuration; recovery is automatic after credentials change.`;
  }

  private release(lease: Lease) {
    if (!lease.retired || lease.users !== 0 || lease.disposal !== undefined) return;

    lease.disposal = lease.connection[Symbol.asyncDispose]()
      .catch((cause) => this.events.failed(cause))
      .finally(() => this.leases.delete(lease));
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
