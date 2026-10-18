import { ProtocolError } from "@modelcontextprotocol/client";
import {
  SandboxExecutionError,
  type ExecutionReport,
  type ToolException,
  type SandboxTool,
  type ToolContext,
} from "@codemode-mcp-gateway/codemode";
import {
  executionOutcome,
  type ExecutionContext,
  type ExecutionOutcome,
  type SessionContext,
  type LogTraceContext,
} from "./events.ts";
import { type Logger } from "./logger.ts";
import { type Telemetry, type SpanObservation, type CallOutcome } from "./telemetry.ts";
import { AuthorizationError } from "../auth/result.ts";

/** Execution-local identifiers are passed explicitly through worker callbacks, not ambient globals. */
export class ExecutionObservation {
  private readonly started = performance.now();
  private readonly attributes: ExecutionContext;
  private readonly operation: SpanObservation | undefined;
  private readonly callTraces = new Map<number, LogTraceContext>();
  private admission: "admitted" | "rejected" = "rejected";

  constructor(
    private readonly logger: Logger | undefined,
    session: SessionContext,
    private readonly telemetry?: Telemetry,
  ) {
    this.attributes = { ...session, "gw.execution.id": crypto.randomUUID() };
    this.operation = telemetry?.startSpan("gw.execution", this.attributes);
  }

  admitted(): void {
    this.admission = "admitted";
  }

  async call(
    name: string,
    transport: "http" | "stdio",
    qualified: string,
    tool: SandboxTool,
    args: unknown,
    context: ToolContext,
  ) {
    if (this.telemetry === undefined) return tool(args, context);

    const started = performance.now();

    const attributes = {
      "mcp.method.name": "tools/call",
      "gw.upstream.name": name,
      "gw.upstream.transport": transport,
      "gw.tool.name": qualified,
      ...(context.callId === undefined ? {} : { "gw.tool.call_id": context.callId }),
    };

    const operation = this.telemetry.startSpan("gw.upstream.call", attributes, this.operation);
    if (operation !== undefined && context.callId !== undefined)
      this.callTraces.set(context.callId, operation.trace);

    const response = this.telemetry.trackResponse(context);
    let finished = false;

    const finish = (outcome: CallOutcome) => {
      if (finished) return;

      finished = true;
      context.signal.removeEventListener("abort", abort);
      response.dispose();
      this.telemetry?.callFinished(name, transport, outcome, performance.now() - started);
      operation?.end(
        { "gw.upstream.call.outcome": outcome },
        outcome !== "response" && outcome !== "interrupted",
      );
    };

    const abort = () => finish("interrupted");
    context.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted) abort();

    try {
      const result = await tool(args, context);
      if (result.ok) finish(response.isError ? "mcp_tool_error" : "response");
      else finish("cause" in result.error ? callFailure(result.error.cause) : "tool_failure");

      return result;
    } catch (cause) {
      finish(callFailure(cause));
      throw cause;
    }
  }

  toolException(exception: ToolException): void {
    this.logger?.emit(
      {
        name: "gw.tool.exception",
        attributes: {
          ...this.attributes,
          "gw.tool.name": exception.name,
          "gw.tool.call_id": exception.callId,
          "error.type": exception.cause instanceof ProtocolError ? "mcp_protocol" : "host_tool",
        },
      },
      this.callTraces.get(exception.callId) ?? this.operation?.trace,
    );
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
    const durationMs = Math.max(0, performance.now() - this.started);

    const failed =
      outcome["gw.execution.outcome"] !== "success" &&
      outcome["gw.execution.outcome"] !== "cancelled";

    const attributes = {
      ...this.attributes,
      ...outcome,
      "gw.execution.duration_ms": durationMs,
      "gw.execution.calls.total": calls.length,
      "gw.execution.calls.completed": calls.filter((call) => call.status === "completed").length,
      "gw.execution.calls.interrupted": calls.filter((call) => call.status === "interrupted")
        .length,
      ...(outcome["gw.execution.outcome"] === "success" ||
      outcome["gw.execution.outcome"] === "cancelled"
        ? {}
        : { "error.type": outcome["gw.execution.outcome"] }),
    };

    this.telemetry?.executionFinished(
      this.attributes["gw.transport"],
      outcome,
      this.admission,
      durationMs,
    );
    this.operation?.end({ ...attributes, "gw.execution.admission": this.admission }, failed);
    this.logger?.emit({ name: "gw.execution.finished", attributes }, this.operation?.trace);
  }
}

function callFailure(cause: unknown): CallOutcome {
  if (cause instanceof ProtocolError) return "protocol_error";

  if (cause instanceof AuthorizationError) return "authorization_error";

  return "exception";
}
