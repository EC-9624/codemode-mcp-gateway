import { type SandboxTool } from "./tools.ts";

export type ToolCallLimit = {
  kind: "limit";
  resource: "tool-calls" | "concurrent-tool-calls";
  maximum: number;
  message: string;
};

/** Expected execution outcomes. Infrastructure failures reject instead of appearing in this union. */
export type SandboxResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { kind: "script" | "timeout"; message: string } }
  | { ok: false; error: ToolCallLimit }
  | { ok: false; error: { kind: "limit"; resource: "output"; maximum: number; message: string } }
  | { ok: false; error: { kind: "cancelled"; message: string } }
  | { ok: false; error: { kind: "limit"; resource: "source"; maximum: number; message: string } }
  | {
      ok: false;
      error: { kind: "limit"; resource: "executions"; maximum: number; message: string };
    };

/** Why execution stopped observing a dispatched call, not the tool's external outcome. */
export type InterruptionReason =
  | "cancelled"
  | "timeout"
  | "script-error"
  | "sandbox-error"
  | "call-limit"
  | "concurrency-limit"
  | "output-limit";

/**
 * Metadata-only observations; no tool arguments or response bodies are retained.
 * Completed means a response was serialized, not proof of success, external effects, or guest receipt.
 */
export type CallOutcome = {
  /** Execution-local sequence, starting at 1. Records remain in invocation order. */
  readonly callId: number;
  readonly name: string;
} & (
  | { readonly status: "completed" }
  | { readonly status: "interrupted"; readonly reason: InterruptionReason }
);

/** Final execution outcome and parent-observed calls; not a transaction or retry guarantee. */
export type ExecutionReport = {
  readonly result: SandboxResult;
  /** Fixed when the outcome is selected; late tool completions cannot update these observations. */
  readonly calls: readonly CallOutcome[];
};
export type ExecuteOptions = {
  /** Host-supplied bindings, snapshotted at admission. Replace constructor defaults; {} exposes no tools. */
  tools?: Readonly<Record<string, SandboxTool>>;
  /** Caller cancellation. The reason stays private; worker cleanup is still awaited. */
  signal?: AbortSignal;
};

/** Fixed configuration and default tool bindings, snapshotted at construction. */
export type SandboxOptions = {
  /** Default bindings when execute omits tools. The application owns their external resources. */
  tools?: Readonly<Record<string, SandboxTool>>;
  /** Guest deadline after VM and bridge setup, including source parsing and host waits. Default: 1000 ms. */
  timeoutMs?: number;
  /**
   * Optional deadline from worker construction through acceptance of completion. Cleanup follows
   * and may outlast it; this is not a hard response-latency cap. Default: no parent deadline.
   */
  totalTimeoutMs?: number;
  /** QuickJS guest heap limit. Defaults to 64 MiB. */
  memoryLimitBytes?: number;
  /** QuickJS stack guard, at most 4 MiB. Defaults to 1 MiB. */
  maxStackSizeBytes?: number;
  /** Submitted source in UTF-8 bytes. Defaults to 256 KiB. */
  maxSourceBytes?: number;
  /** Final JSON return value or script-error message in UTF-8 bytes. Defaults to 256 KiB. */
  maxOutputBytes?: number;
  /** Total admitted calls, including failed responses. Defaults to 100. */
  maxToolCalls?: number;
  /** Outstanding calls. Exceeding this limit stops execution. Defaults to 10. */
  maxConcurrentToolCalls?: number;
  /** Active executions per executor, including worker cleanup. Defaults to 4; excess calls are rejected. */
  maxConcurrentExecutions?: number;
};
