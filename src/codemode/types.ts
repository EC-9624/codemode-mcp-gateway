import { type SandboxTool, type SerializedToolResult } from "./tools";

export type ToolCallLimit = {
  kind: "limit";
  resource: "tool-calls" | "concurrent-tool-calls";
  maximum: number;
  message: string;
};

export type SandboxResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { kind: "script" | "timeout"; message: string } }
  | { ok: false; error: ToolCallLimit }
  | { ok: false; error: { kind: "limit"; resource: "output"; maximum: number; message: string } }
  | { ok: false; error: { kind: "cancelled"; message: string } }
  | { ok: false; error: { kind: "limit"; resource: "source"; maximum: number; message: string } };

/** Why execution stopped observing a dispatched call, not the tool's external outcome. */
export type InterruptionReason =
  | "cancelled"
  | "timeout"
  | "script-error"
  | "sandbox-error"
  | "call-limit"
  | "concurrency-limit"
  | "output-limit";

/** Parent observations, not proof of external side effects or guest receipt. */
export type CallOutcome = {
  readonly callId: number;
  readonly name: string;
} & (
  | { readonly status: "completed"; readonly result: SerializedToolResult }
  | { readonly status: "interrupted"; readonly reason: InterruptionReason }
);

export type ExecutionReport = {
  readonly result: SandboxResult;
  readonly calls: readonly CallOutcome[];
};
export type ExecuteOptions = {
  /** Guest deadline after VM creation, including host waits. Defaults to 1000 ms. */
  timeoutMs?: number;
  /** Optional parent deadline through completion acceptance; worker cleanup follows. */
  totalTimeoutMs?: number;
  /** Caller cancellation. The reason stays private; worker cleanup is still awaited. */
  signal?: AbortSignal;
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
};

/** Defaults and tool bindings are snapshotted at construction; cancellation is per execution. */
export type SandboxOptions = Omit<ExecuteOptions, "signal"> & {
  tools?: Readonly<Record<string, SandboxTool>>;
};
