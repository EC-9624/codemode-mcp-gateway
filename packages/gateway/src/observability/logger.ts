import { gatewayVersion } from "../version.ts";
import { logConfiguration, type LogLevel } from "./config.ts";
import { describeEvent, type GatewayEvent, type GatewayLog } from "./events.ts";
import { renderLog } from "./presentation.ts";

export type LoggerOptions = {
  serviceName?: string;
  version?: string;
  instanceId?: string;
  level?: LogLevel;
  /** Overrides local stderr rendering. A throwing sink is reported locally once, never retried. */
  onLog?: (record: GatewayLog) => void;
};

/** Local structured events only. No global registration, trace generation, or network export. */
export class Logger {
  readonly resource: GatewayLog["resource"];
  readonly instrumentationScope: GatewayLog["instrumentationScope"];
  private readonly minimum: number;
  private readonly write: (record: GatewayLog) => void;
  private readonly usesStderr: boolean;
  private failed = false;
  private dropped = 0;

  static async fromEnvironment(): Promise<Logger> {
    return new Logger({ ...logConfiguration(process.env), version: await gatewayVersion() });
  }

  constructor(options: LoggerOptions = {}) {
    this.resource = Object.freeze({
      "service.name": options.serviceName ?? "codemode-mcp-gateway",
      "service.version": options.version ?? "unknown",
      "service.instance.id": options.instanceId ?? crypto.randomUUID(),
    });
    this.instrumentationScope = Object.freeze({
      name: "codemode-mcp-gateway",
      version: this.resource["service.version"],
    });
    this.minimum = { debug: 5, info: 9, warn: 13, error: 17 }[options.level ?? "info"];
    this.usesStderr = options.onLog === undefined;
    this.write =
      options.onLog ??
      ((record) => console.error(renderLog(record, process.stderr.isTTY === true)));
  }

  emit(event: GatewayEvent): void {
    const description = describeEvent(event);
    if (description.severityNumber < this.minimum) return;

    // Drop complete records instead of growing stderr's buffered queue without bound.
    if (this.usesStderr && process.stderr.writableLength > 65_536) {
      this.dropped++;

      return;
    }

    if (this.dropped > 0) {
      this.reportFailure({
        "gw.logging.failure": "backpressure",
        "gw.logging.dropped": this.dropped,
      });
      this.dropped = 0;
    }

    const record: GatewayLog = Object.freeze({
      timestamp: new Date().toISOString(),
      ...description,
      eventName: event.name,
      attributes: Object.freeze({ ...event.attributes }),
      resource: this.resource,
      instrumentationScope: this.instrumentationScope,
    });

    try {
      this.write(record);
    } catch {
      if (this.failed) return;

      this.failed = true;
      this.reportFailure({ "gw.logging.failure": "sink" });
    }
  }

  private reportFailure(
    attributes: Extract<GatewayEvent, { name: "gw.logging.failed" }>["attributes"],
  ) {
    const event = { name: "gw.logging.failed", attributes } as const;

    try {
      console.error(
        renderLog(
          {
            timestamp: new Date().toISOString(),
            ...describeEvent(event),
            eventName: event.name,
            attributes,
            resource: this.resource,
            instrumentationScope: this.instrumentationScope,
          },
          process.stderr.isTTY === true,
        ),
      );
    } catch {
      // A failed stderr leaves no delivery channel. Logging must not change a tool's outcome.
    }
  }
}
