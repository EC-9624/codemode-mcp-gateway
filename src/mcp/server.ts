import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  CodemodeSandbox,
  createDiscoveryTools,
  SandboxExecutionError,
  type CallOutcome,
  type ExecutionReport,
} from "../codemode";
import { type CodemodeServerOptions, type CallSummary, type CodemodeResponse } from "./types";

/** Borrows the catalog's tools. Closing cancels executions and awaits worker cleanup. */
export function createCodemodeServer(options: CodemodeServerOptions): McpServer {
  return new CodemodeServer(options);
}

class CodemodeServer extends McpServer {
  private readonly sandbox: CodemodeSandbox;
  private readonly shutdown = new AbortController();
  private readonly executions = new Set<Promise<ExecutionReport>>();
  private closing: Promise<void> | undefined;

  constructor(options: CodemodeServerOptions) {
    super({ name: "mcm", version: "0.0.0" });
    const discovery = createDiscoveryTools(options.catalog);
    for (const name of Object.keys(discovery)) {
      if (Object.hasOwn(options.catalog.tools, name)) {
        throw new Error(
          `Upstream tool ${JSON.stringify(name)} conflicts with an MCM discovery helper.`,
        );
      }
    }

    this.sandbox = new CodemodeSandbox({
      ...options.sandbox,
      tools: { ...options.catalog.tools, ...discovery },
    });

    this.registerTool(
      "execute",
      {
        description: `Run JavaScript as an async function body in a fresh QuickJS sandbox.
Start with: return await tools.searchTools({ query: "what you need" });
Search returns exact tool names, descriptions, and input schemas. Inspect one with
tools.describeTool({ name }). Call it with await tools["exact-name"](args).
Upstream MCP tools resolve to { content, structuredContent?, isError? }; check isError.
Use JavaScript to chain calls, run independent calls concurrently, and filter results.
Return the JSON value you want to see. No fetch, filesystem, process, or imports are available.
Resource limits are server-owned. The response includes the result and compact call summaries;
completed calls are observations, not a guarantee of external success or safe retry.`,
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
    const execution = this.sandbox.execute(code, { signal });
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
