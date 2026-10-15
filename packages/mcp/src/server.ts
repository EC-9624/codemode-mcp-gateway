/**
 * Agent-facing MCP adapter over a borrowed executor. Requests accept only code; the
 * application chooses the engine, tools, and resource policy outside this module.
 *
 * Each request tracks its execution promise before invoking the callback. Responses
 * keep the final result and metadata-only call summaries. Executor
 * rejections become controlled public failures with host-only diagnostics.
 *
 * Closing aborts the server's request signals and awaits the tracked executions.
 * It does not dispose a shared executor or its upstream client, so the callback
 * must settle only after its own execution cleanup.
 */
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { SandboxExecutionError, type CallOutcome, type ExecutionReport } from "@cmg/codemode";
import { type CodemodeServerOptions, type CallSummary, type CodemodeResponse } from "./types.ts";

/** Borrows an executor. Closing aborts this server's requests and awaits their execution cleanup. */
export function createCodemodeServer(options: CodemodeServerOptions): McpServer {
  return new CodemodeServer(options);
}

class CodemodeServer extends McpServer {
  private readonly execute: CodemodeServerOptions["execute"];
  private readonly shutdown = new AbortController();
  private readonly executions = new Set<Promise<ExecutionReport>>();
  private closing: Promise<void> | undefined;

  constructor(options: CodemodeServerOptions) {
    super({ name: "codemode-mcp-gateway", version: "0.0.0" });
    this.execute = options.execute;

    this.registerTool(
      "execute",
      {
        description:
          options.description ??
          `Run JavaScript using an application-supplied executor.
Return the value you want to see. Tools and resource policy are configured by the application.
The response includes the execution result and compact call summaries. Completed calls are
observations, not a guarantee of external success or safe retry.`,
        inputSchema: z.strictObject({ code: z.string() }),
      },
      ({ code }, { mcpReq }) => this.executeCode(code, mcpReq.signal),
    );
  }

  override close(): Promise<void> {
    this.closing ??= this.stop();

    return this.closing;
  }

  private async stop(): Promise<void> {
    this.shutdown.abort();
    try {
      await super.close();
    } finally {
      await Promise.allSettled(this.executions);
    }
  }

  private async executeCode(code: string, requestSignal: AbortSignal): Promise<CallToolResult> {
    const signal = AbortSignal.any([requestSignal, this.shutdown.signal]);

    // Scheduling also turns synchronous executor exceptions into the controlled rejection path.
    const execution = Promise.resolve().then(() => {
      // SDK validation may finish after close has already drained tracked executions.
      if (this.shutdown.signal.aborted)
        return {
          result: { ok: false, error: { kind: "cancelled", message: "Execution cancelled." } },
          calls: [],
        } satisfies ExecutionReport;

      return this.execute(code, { signal });
    });

    this.executions.add(execution);

    let report: ExecutionReport;
    try {
      report = await execution;
    } catch (cause) {
      const failure = response({
        result: { ok: false, error: { kind: "sandbox", message: "Sandbox execution failed." } },
        calls: summarize(cause instanceof SandboxExecutionError ? cause.calls : []),
      });

      try {
        this.server.onerror?.(new Error("Sandbox execution failed.", { cause }));
      } catch {
        // The SDK publishes handler exceptions. A failing diagnostic hook must
        // not replace the controlled failure or expose its own private message.
        return failure;
      }

      return failure;
    } finally {
      this.executions.delete(execution);
    }

    return response({ result: report.result, calls: summarize(report.calls) });
  }
}

function summarize(calls: readonly CallOutcome[]): CallSummary[] {
  // Injected executors can attach additional fields despite the public structural type.
  return calls.map((call) => {
    const summary = { callId: call.callId, name: call.name };

    return call.status === "completed"
      ? { ...summary, status: "completed" }
      : { ...summary, status: "interrupted", reason: call.reason };
  });
}

function response(value: CodemodeResponse): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError: !value.result.ok,
  };
}
