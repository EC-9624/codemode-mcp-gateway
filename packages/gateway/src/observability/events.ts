import { type SandboxResult } from "@codemode-mcp-gateway/codemode";
import { type ServerStatus } from "../server-status.ts";

export type Transport = "http" | "stdio" | "embedded";
export type SessionContext = { "gw.transport": Transport; "gw.session.id": string };
export type ExecutionContext = SessionContext & { "gw.execution.id": string };
type LimitResource = Extract<
  Extract<SandboxResult, { ok: false }>["error"],
  { kind: "limit" }
>["resource"];
export type ExecutionOutcome =
  | {
      "gw.execution.outcome":
        | "success"
        | "script_error"
        | "timeout"
        | "cancelled"
        | "infrastructure_error";
    }
  | { "gw.execution.outcome": "limit"; "gw.execution.limit.resource": LimitResource };

export type FailureType =
  | "infrastructure"
  | "cleanup"
  | "mcp_protocol"
  | "host_tool"
  | "output_storage"
  | "connect"
  | "connection"
  | "discovery"
  | "credentials-changed"
  | "upstream_authorization"
  | "invalid-options"
  | "address-in-use"
  | "listen-failed"
  | "script_error"
  | "timeout"
  | "limit"
  | "infrastructure_error";
type Failure = { "error.type": FailureType };
export type SessionCloseReason =
  | "client"
  | "idle"
  | "shutdown"
  | "initialization_failed"
  | "transport";

/** Allowlisted metadata only. Code, arguments, results, and arbitrary error messages have no slot. */
export type GatewayEvent =
  | {
      name: "gw.service.started";
      attributes: { "gw.transport": Transport; "server.port"?: number; "process.pid": number };
    }
  | {
      name: "gw.service.stopped";
      attributes: {
        "gw.transport": Transport;
        "gw.shutdown.reason": "signal" | "eof" | "failure" | "host";
        "gw.service.duration_ms": number;
      };
    }
  | {
      name: "gw.service.failed";
      attributes: Failure & { "gw.component": "http" | "stdio" | "gateway" | "cleanup" };
    }
  | {
      name: "gw.upstream.state_changed";
      attributes: {
        "gw.upstream.name": string;
        "gw.upstream.state": ServerStatus["state"];
        "gw.upstream.previous_state"?: string;
        "gw.upstream.tools": number;
        "error.type"?: FailureType;
      };
    }
  | { name: "gw.session.opened"; attributes: SessionContext }
  | {
      name: "gw.session.closed";
      attributes: SessionContext & {
        "gw.session.close_reason": SessionCloseReason;
        "gw.session.duration_ms": number;
      };
    }
  | {
      name: "gw.execution.finished";
      attributes: ExecutionContext &
        ExecutionOutcome & {
          "gw.execution.duration_ms": number;
          "gw.execution.calls.total": number;
          "gw.execution.calls.completed": number;
          "gw.execution.calls.interrupted": number;
          "error.type"?: FailureType;
        };
    }
  | {
      name: "gw.tool.exception";
      attributes: ExecutionContext &
        Failure & { "gw.tool.name": string; "gw.tool.call_id": number };
    }
  | { name: "gw.protocol.failed"; attributes: SessionContext & Failure }
  | { name: "gw.output.save_failed"; attributes: SessionContext & Failure }
  | {
      name: "gw.logging.failed";
      attributes:
        | { "gw.logging.failure": "sink" }
        | { "gw.logging.failure": "backpressure"; "gw.logging.dropped": number };
    }
  | {
      name: "gw.telemetry.failed";
      attributes: { "gw.component": "traces" | "metrics" | "shutdown" };
    };

export type LogTraceContext = {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
};

export type GatewayLog = {
  readonly timestamp: string;
  readonly severityNumber: 5 | 9 | 13 | 17;
  readonly severityText: "DEBUG" | "INFO" | "WARN" | "ERROR";
  readonly eventName: GatewayEvent["name"];
  readonly body: string;
  readonly attributes: GatewayEvent["attributes"];
  readonly resource: {
    "service.name": string;
    "service.version": string;
    "service.instance.id": string;
  };
  readonly instrumentationScope: { name: string; version: string };
  readonly traceId?: string;
  readonly spanId?: string;
  readonly traceFlags?: number;
};

export function executionOutcome(result: SandboxResult): ExecutionOutcome {
  if (result.ok) return { "gw.execution.outcome": "success" };

  if (result.error.kind === "limit")
    return {
      "gw.execution.outcome": "limit",
      "gw.execution.limit.resource": result.error.resource,
    };

  return {
    "gw.execution.outcome": result.error.kind === "script" ? "script_error" : result.error.kind,
  };
}

export function describeEvent(
  event: GatewayEvent,
): Pick<GatewayLog, "severityNumber" | "severityText" | "body"> {
  switch (event.name) {
    case "gw.service.started":
      return info("Gateway listening.");
    case "gw.service.stopped":
      return info("Gateway stopped.");
    case "gw.service.failed":
      return { severityNumber: 17, severityText: "ERROR", body: "Gateway infrastructure failed." };
    case "gw.upstream.state_changed":
      return event.attributes["gw.upstream.state"] === "failed" ||
        event.attributes["gw.upstream.state"] === "needs-auth"
        ? warn("Upstream unavailable.")
        : info("Upstream state changed.");
    case "gw.session.opened":
      return { severityNumber: 5, severityText: "DEBUG", body: "MCP session opened." };
    case "gw.session.closed":
      return { severityNumber: 5, severityText: "DEBUG", body: "MCP session closed." };
    case "gw.execution.finished":
      if (event.attributes["gw.execution.outcome"] === "infrastructure_error")
        return {
          severityNumber: 17,
          severityText: "ERROR",
          body: "Execution infrastructure failed.",
        };

      if (["success", "cancelled"].includes(event.attributes["gw.execution.outcome"]))
        return info("Execution finished.");

      return warn("Execution finished.");
    case "gw.tool.exception":
      return warn("Upstream tool failed.");
    case "gw.protocol.failed":
      return warn("MCP protocol operation failed.");
    case "gw.output.save_failed":
      return warn("Full output could not be saved.");
    case "gw.logging.failed":
      return warn("Log delivery failed; execution is unaffected.");
    case "gw.telemetry.failed":
      return warn("Telemetry delivery failed; execution is unaffected.");
  }
}

function info(body: string) {
  return { severityNumber: 9, severityText: "INFO", body } as const;
}

function warn(body: string) {
  return { severityNumber: 13, severityText: "WARN", body } as const;
}
