import { type CallOutcome, type ExecutionReport, type SandboxResult } from "@cmg/codemode";

export type McpCatalogOptions = {
  /** Overall tool discovery deadline in milliseconds. Defaults to 15000. */
  timeoutMs?: number;
  /** Cancels discovery only. Invocation uses the execution's ToolContext.signal. */
  signal?: AbortSignal;
};

export type CodemodeServerOptions = {
  /**
   * Borrowed executor. Honor the request signal and settle only after owned execution cleanup.
   * Expected failures return ExecutionReport; rejections become controlled sandbox errors.
   * Closing the MCP server aborts its requests, not the executor's unrelated work.
   */
  execute: (code: string, options: { signal: AbortSignal }) => Promise<ExecutionReport>;
  /** Describe the actual supplied environment; the default makes no engine-specific claims. */
  description?: string;
};

/** The executor's metadata-only observations, also used at the MCP boundary. */
export type CallSummary = CallOutcome;

/** Agent-facing projection, emitted as both structured content and JSON text without tool bodies. */
export type CodemodeResponse = {
  result: SandboxResult | { ok: false; error: { kind: "sandbox"; message: string } };
  calls: CallSummary[];
};
