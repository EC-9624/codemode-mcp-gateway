import { type ExecutionReport, type InterruptionReason, type SandboxResult } from "@cmg/codemode";

export type McpCatalogOptions = {
  /** Overall tool discovery deadline in milliseconds. Defaults to 15000. */
  timeoutMs?: number;
  /** Cancels discovery only. Invocation uses the execution's ToolContext.signal. */
  signal?: AbortSignal;
};

export type CodemodeServerOptions = {
  /** Must honor cancellation and settle only after owned execution cleanup. */
  execute: (code: string, options: { signal: AbortSignal }) => Promise<ExecutionReport>;
  /** Describe the actual supplied environment; the default makes no engine-specific claims. */
  description?: string;
};

/** Compact observations: completed means a response was recorded, not external success. */
export type CallSummary = {
  callId: number;
  name: string;
} & ({ status: "completed" } | { status: "interrupted"; reason: InterruptionReason });

export type CodemodeResponse = {
  result: SandboxResult | { ok: false; error: { kind: "sandbox"; message: string } };
  calls: CallSummary[];
};
