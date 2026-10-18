import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
} from "@opentelemetry/api";
import { type ExportResult } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type SpanExporter,
  type Sampler,
} from "@opentelemetry/sdk-trace-base";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type IMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import { type ToolContext } from "@codemode-mcp-gateway/codemode";
import { type ServerStatus } from "../upstream/upstream.ts";
import { type Logger } from "./logger.ts";
import {
  type GatewayLog,
  type LogTraceContext,
  type Transport,
  type ExecutionOutcome,
} from "./events.ts";
import { telemetryConfiguration } from "./telemetry-config.ts";

export type SpanObservation = {
  context: Context;
  trace: LogTraceContext;
  end: (attributes: Attributes, failed?: boolean) => void;
};
export type CallOutcome =
  | "response"
  | "mcp_tool_error"
  | "protocol_error"
  | "authorization_error"
  | "tool_failure"
  | "exception"
  | "interrupted";
export type TelemetryOptions = {
  logger?: Logger;
  resource?: GatewayLog["resource"];
  spanExporter?: SpanExporter;
  metrics?:
    | { kind: "reader"; reader: IMetricReader }
    | { kind: "exporter"; exporter: PushMetricExporter; timeoutMillis: number };
  sampler?: Sampler;
};

/** Owns metrics/traces only. No global providers, ambient context, log exporter, or payload capture. */
export class Telemetry implements AsyncDisposable {
  readonly resource: GatewayLog["resource"];
  private readonly traces: BasicTracerProvider;
  private readonly metrics: MeterProvider;
  private readonly instruments;
  private readonly logger: Logger | undefined;
  private readonly tracing: boolean;
  private readonly gateways = new Set<() => { active: number; servers: readonly ServerStatus[] }>();
  private readonly responses = new WeakMap<ToolContext, { isError: boolean }>();
  private readonly failures = new Set<string>();
  private closed = false;
  private closing: Promise<void> | undefined;

  static async fromEnvironment(logger: Logger): Promise<Telemetry | undefined> {
    const config = telemetryConfiguration(process.env);
    if (config.traces === undefined && config.metrics === undefined) return;

    // Exporters are branch-specific: ordinary local serving neither constructs nor contacts one.
    const options: TelemetryOptions = { logger };
    if (config.traces !== undefined) {
      const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-proto");

      const exporter = new OTLPTraceExporter({
        url: config.traces.endpoint,
        headers: config.traces.headers,
        timeoutMillis: config.traces.timeoutMillis,
      });

      options.spanExporter = exporter;
    }

    if (config.metrics !== undefined) {
      const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-proto");

      const exporter = new OTLPMetricExporter({
        url: config.metrics.endpoint,
        headers: config.metrics.headers,
        timeoutMillis: config.metrics.timeoutMillis,
      });

      options.metrics = { kind: "exporter", exporter, timeoutMillis: config.metrics.timeoutMillis };
    }

    return new Telemetry(options);
  }

  constructor(options: TelemetryOptions = {}) {
    this.logger = options.logger;
    this.tracing = options.spanExporter !== undefined;

    const identity = options.resource ??
      options.logger?.resource ?? {
        "service.name": "codemode-mcp-gateway",
        "service.version": "unknown",
        "service.instance.id": crypto.randomUUID(),
      };

    this.resource = Object.freeze({
      "service.name": identity["service.name"],
      "service.version": identity["service.version"],
      "service.instance.id": identity["service.instance.id"],
    });
    const resource = resourceFromAttributes(this.resource);
    const exporter = options.spanExporter;

    const processors =
      exporter === undefined
        ? []
        : [
            new BatchSpanProcessor(
              {
                export: this.observeExport(exporter, "traces"),
                shutdown: () => exporter.shutdown(),
              },
              {
                maxQueueSize: 128,
                maxExportBatchSize: 128,
                scheduledDelayMillis: 1000,
                exportTimeoutMillis: 2000,
              },
            ),
          ];

    this.traces = new BasicTracerProvider({
      resource,
      spanProcessors: processors,
      forceFlushTimeoutMillis: 2000,
      ...(options.sampler === undefined ? {} : { sampler: options.sampler }),
      spanLimits: { attributeCountLimit: 32, attributeValueLengthLimit: 256 },
    });
    const metric = options.metrics;
    const readers: IMetricReader[] = [];
    if (metric?.kind === "reader") readers.push(metric.reader);

    if (metric?.kind === "exporter")
      readers.push(
        new PeriodicExportingMetricReader({
          exporter: {
            export: this.observeExport(metric.exporter, "metrics"),
            forceFlush: () => metric.exporter.forceFlush(),
            shutdown: () => metric.exporter.shutdown(),
            ...(metric.exporter.selectAggregationTemporality === undefined
              ? {}
              : {
                  selectAggregationTemporality: metric.exporter.selectAggregationTemporality.bind(
                    metric.exporter,
                  ),
                }),
            ...(metric.exporter.selectAggregation === undefined
              ? {}
              : { selectAggregation: metric.exporter.selectAggregation.bind(metric.exporter) }),
          },
          exportIntervalMillis: 10_000,
          exportTimeoutMillis: metric.timeoutMillis,
          cardinalityLimits: { default: 128 },
        }),
      );

    this.metrics = new MeterProvider({ resource, readers });
    const meter = this.metrics.getMeter("codemode-mcp-gateway", this.resource["service.version"]);
    this.instruments = {
      executions: meter.createCounter("gw.execution.count", { unit: "{execution}" }),
      duration: meter.createHistogram("gw.execution.duration", { unit: "s" }),
      calls: meter.createCounter("gw.upstream.call.count", { unit: "{call}" }),
      callDuration: meter.createHistogram("gw.upstream.call.duration", { unit: "s" }),
      connections: meter.createCounter("gw.upstream.connection.count", { unit: "{attempt}" }),
      connectionDuration: meter.createHistogram("gw.upstream.connection.duration", { unit: "s" }),
      sessions: meter.createUpDownCounter("gw.session.active", { unit: "{session}" }),
    };
    const active = meter.createObservableGauge("gw.execution.active", { unit: "{execution}" });
    const states = meter.createObservableGauge("gw.upstream.state", { unit: "{upstream}" });
    active.addCallback((result) => {
      result.observe([...this.gateways].reduce((total, observe) => total + observe().active, 0));
    });
    states.addCallback((result) => {
      const counts = new Map<string, Map<ServerStatus["state"], number>>();
      for (const observe of this.gateways)
        for (const server of observe().servers) {
          const byState = counts.get(server.name) ?? new Map<ServerStatus["state"], number>();
          byState.set(server.state, (byState.get(server.state) ?? 0) + 1);
          counts.set(server.name, byState);
        }

      for (const [name, byState] of counts)
        for (const state of [
          "disabled",
          "connecting",
          "connected",
          "needs-auth",
          "failed",
        ] as const)
          result.observe(byState.get(state) ?? 0, {
            "gw.upstream.name": name,
            "gw.upstream.state": state,
          });
    });
  }

  registerGateway(observe: () => { active: number; servers: readonly ServerStatus[] }): () => void {
    this.gateways.add(observe);

    return () => {
      this.gateways.delete(observe);
    };
  }

  startSpan(
    name:
      | "gw.execution"
      | "gw.upstream.call"
      | "gw.upstream.connect"
      | "gw.upstream.initialize"
      | "gw.upstream.discovery",
    attributes: Attributes,
    parent?: SpanObservation,
  ): SpanObservation | undefined {
    if (this.closed || !this.tracing) return;

    try {
      const span = this.traces
        .getTracer("codemode-mcp-gateway", this.resource["service.version"])
        .startSpan(
          name,
          { attributes, kind: name === "gw.upstream.call" ? SpanKind.CLIENT : SpanKind.INTERNAL },
          parent?.context ?? ROOT_CONTEXT,
        );

      const context = span.spanContext();
      let ended = false;

      return {
        context: trace.setSpan(parent?.context ?? ROOT_CONTEXT, span),
        trace: { traceId: context.traceId, spanId: context.spanId, traceFlags: context.traceFlags },
        end: (attributes, failed = false) => {
          if (ended) return;

          ended = true;
          try {
            span.setAttributes(attributes);
            if (failed) span.setStatus({ code: SpanStatusCode.ERROR });

            span.end();
          } catch {
            this.failure("traces");
          }
        },
      };
    } catch {
      this.failure("traces");

      return;
    }
  }

  executionFinished(
    transport: Transport,
    outcome: ExecutionOutcome,
    admission: "admitted" | "rejected",
    durationMs: number,
  ): void {
    const attributes = {
      "gw.transport": transport,
      ...outcome,
      "gw.execution.admission": admission,
    };

    this.measure(() => {
      this.instruments.executions.add(1, attributes);
      this.instruments.duration.record(durationMs / 1000, attributes);
    });
  }

  callFinished(
    name: string,
    transport: "http" | "stdio",
    outcome: CallOutcome,
    durationMs: number,
  ): void {
    const attributes = {
      "gw.upstream.name": name,
      "gw.upstream.transport": transport,
      "gw.upstream.call.outcome": outcome,
    };

    this.measure(() => {
      this.instruments.calls.add(1, attributes);
      this.instruments.callDuration.record(durationMs / 1000, attributes);
    });
  }

  connectionFinished(
    name: string,
    transport: "http" | "stdio",
    trigger: "initial" | "recovery",
    outcome: ServerStatus["state"] | "cancelled" | "infrastructure_error",
    durationMs: number,
  ): void {
    const attributes = {
      "gw.upstream.name": name,
      "gw.upstream.transport": transport,
      "gw.upstream.connection.trigger": trigger,
      "gw.upstream.connection.outcome": outcome,
    };

    this.measure(() => {
      this.instruments.connections.add(1, attributes);
      this.instruments.connectionDuration.record(durationMs / 1000, attributes);
    });
  }

  sessionChanged(transport: Transport, delta: 1 | -1): void {
    this.measure(() => this.instruments.sessions.add(delta, { "gw.transport": transport }));
  }

  /** The adapter supplies this known MCP flag; never inspect arbitrary tool JSON for failure. */
  toolResponse(context: ToolContext, isError: boolean): void {
    const response = this.responses.get(context);
    if (response !== undefined) response.isError = isError;
  }

  trackResponse(context: ToolContext): { isError: boolean; dispose: () => void } {
    const response = {
      isError: false,
      dispose: () => {
        this.responses.delete(context);
      },
    };

    this.responses.set(context, response);

    return response;
  }

  close(): Promise<void> {
    this.closing ??= this.shutdown();

    return this.closing;
  }

  /** Best-effort checkpoint; failures are controlled diagnostics, never tool failures. */
  async flush(): Promise<void> {
    if (this.closed) return;

    const [traces, metrics] = await Promise.allSettled([
      this.traces.forceFlush(),
      this.metrics.forceFlush({ timeoutMillis: 2000 }),
    ]);

    if (traces.status === "rejected") this.failure("traces");

    if (metrics.status === "rejected") this.failure("metrics");
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  private measure(operation: () => void) {
    if (this.closed) return;

    try {
      operation();
    } catch {
      this.failure("metrics");
    }
  }

  private observeExport<T>(
    exporter: { export: (items: T, done: (result: ExportResult) => void) => void },
    component: "traces" | "metrics",
  ) {
    return (items: T, done: (result: ExportResult) => void) => {
      let completed = false;

      const finish = (result: ExportResult) => {
        if (completed) return;

        completed = true;
        if (result.code !== 0) this.failure(component);

        done(result);
      };

      try {
        exporter.export(items, finish);
      } catch {
        this.failure(component);
        finish({ code: 1 });
      }
    };
  }

  private failure(component: "traces" | "metrics" | "shutdown") {
    if (this.failures.has(component)) return;

    this.failures.add(component);
    this.logger?.emit({ name: "gw.telemetry.failed", attributes: { "gw.component": component } });
  }

  private async shutdown() {
    this.closed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.failure("shutdown");
        resolve();
      }, 5000);
    });

    try {
      await Promise.race([
        Promise.allSettled([this.traces.shutdown(), this.metrics.shutdown()]).then((results) => {
          if (results.some((result) => result.status === "rejected")) this.failure("shutdown");
        }),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
      this.gateways.clear();
    }
  }
}
