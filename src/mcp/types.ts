export type McpCatalogOptions = {
  /** Overall tool discovery deadline in milliseconds. Defaults to 15000. */
  timeoutMs?: number;
  /** Cancels discovery only. Invocation uses the execution's ToolContext.signal. */
  signal?: AbortSignal;
};

export type CodemodeServerOptions = {
  catalog: ToolCatalog;
  sandbox?: Omit<SandboxOptions, "tools">;
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
import {
  type InterruptionReason,
  type SandboxOptions,
  type SandboxResult,
  type ToolCatalog,
} from "../codemode";
