import { type ExecutionReport } from "@codemode-mcp-gateway/codemode";

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
  /**
   * Host-owned presentation of returned values or public errors. Closing awaits this promise
   * so output resources can be released afterward. Rejections become controlled presentation
   * errors; execution is never replayed. Recoverable save failures should return a preview.
   */
  formatOutput?: (text: string) => Promise<string>;
};
