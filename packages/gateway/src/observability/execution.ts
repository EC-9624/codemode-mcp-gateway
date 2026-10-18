import { ProtocolError } from "@modelcontextprotocol/client";
import {
  SandboxExecutionError,
  type ExecutionReport,
  type ToolException,
} from "@codemode-mcp-gateway/codemode";
import {
  executionOutcome,
  type ExecutionContext,
  type ExecutionOutcome,
  type SessionContext,
} from "./events.ts";
import { type Logger } from "./logger.ts";

/** Execution-local identifiers are passed explicitly through worker callbacks, not ambient globals. */
export class ExecutionLog {
  private readonly started = performance.now();
  private readonly attributes: ExecutionContext;

  constructor(
    private readonly logger: Logger,
    session: SessionContext,
  ) {
    this.attributes = { ...session, "gw.execution.id": crypto.randomUUID() };
  }

  toolException(exception: ToolException): void {
    this.logger.emit({
      name: "gw.tool.exception",
      attributes: {
        ...this.attributes,
        "gw.tool.name": exception.name,
        "gw.tool.call_id": exception.callId,
        "error.type": exception.cause instanceof ProtocolError ? "mcp_protocol" : "host_tool",
      },
    });
  }

  finish(report: ExecutionReport): void {
    this.complete(executionOutcome(report.result), report.calls);
  }

  failed(cause: unknown): void {
    this.complete(
      { "gw.execution.outcome": "infrastructure_error" },
      cause instanceof SandboxExecutionError ? cause.calls : [],
    );
  }

  private complete(outcome: ExecutionOutcome, calls: ExecutionReport["calls"]) {
    this.logger.emit({
      name: "gw.execution.finished",
      attributes: {
        ...this.attributes,
        ...outcome,
        "gw.execution.duration_ms": Math.max(0, performance.now() - this.started),
        "gw.execution.calls.total": calls.length,
        "gw.execution.calls.completed": calls.filter((call) => call.status === "completed").length,
        "gw.execution.calls.interrupted": calls.filter((call) => call.status === "interrupted")
          .length,
        ...(outcome["gw.execution.outcome"] === "success" ||
        outcome["gw.execution.outcome"] === "cancelled"
          ? {}
          : { "error.type": outcome["gw.execution.outcome"] }),
      },
    });
  }
}
