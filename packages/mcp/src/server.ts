/**
 * Agent-facing MCP adapter over a borrowed executor. Requests accept only code; the
 * application chooses the engine, tools, and resource policy outside this module.
 *
 * Each request is tracked before invoking the executor and through output formatting,
 * so shutdown cannot race application-owned output writes. Responses show only the
 * returned value or useful error text; reports and diagnostics stay host-side.
 * Executor rejections become controlled public failures.
 *
 * Closing aborts the server's request signals and awaits execution and presentation.
 * It does not dispose a shared executor or its upstream client, so the callback
 * must settle only after its own execution cleanup.
 */
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type ExecutionReport } from "@codemode-mcp-gateway/codemode";
import { type CodemodeServerOptions } from "./types.ts";

/** Borrows an executor. Closing awaits this server's execution cleanup and output formatting. */
export function createCodemodeServer(options: CodemodeServerOptions): McpServer {
  return new CodemodeServer(options);
}

class CodemodeServer extends McpServer {
  private readonly execute: CodemodeServerOptions["execute"];
  private readonly formatOutput: CodemodeServerOptions["formatOutput"];
  private readonly shutdown = new AbortController();
  private readonly executions = new Set<Promise<CallToolResult>>();
  private closing: Promise<void> | undefined;

  constructor(options: CodemodeServerOptions) {
    super({ name: "codemode-mcp-gateway", version: "0.0.0" });
    this.execute = options.execute;
    this.formatOutput = options.formatOutput;

    this.registerTool(
      "execute",
      {
        description:
          options.description ??
          `Run JavaScript using an application-supplied executor.
Return the value you want to see. Tools and resource policy are configured by the application.
The response is the returned value or an error message. Tool side effects are not undone
when a script fails; do not blindly replay scripts that may have performed writes.`,
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
      // SDK validation may finish after close has drained requests; never start new work then.
      if (this.shutdown.signal.aborted) return response("Execution cancelled.", true);

      return this.run(code, signal);
    });

    this.executions.add(execution);

    try {
      return await execution;
    } finally {
      this.executions.delete(execution);
    }
  }

  private async run(code: string, signal: AbortSignal): Promise<CallToolResult> {
    let report: ExecutionReport;
    try {
      report = await this.execute(code, { signal });
    } catch (cause) {
      this.diagnose(new Error("Sandbox execution failed.", { cause }));

      return response("Sandbox execution failed.", true);
    }

    const result = report.result;
    try {
      const value = result.ok ? result.value : result.error.message;
      const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");

      return response(await (this.formatOutput?.(text) ?? text), !result.ok);
    } catch (cause) {
      this.diagnose(new Error("Output presentation failed.", { cause }));

      return response(
        result.ok
          ? "Execution completed, but its output could not be displayed."
          : "Execution failed, and its error output could not be displayed.",
        true,
      );
    }
  }

  private diagnose(error: Error): void {
    try {
      this.server.onerror?.(error);
    } catch {
      // SDK handler exceptions become public. Diagnostic failures must not replace safe output.
    }
  }
}

function response(text: string, failed: boolean): CallToolResult {
  return {
    content: [{ type: "text", text }],
    ...(failed ? { isError: true } : {}),
  };
}
