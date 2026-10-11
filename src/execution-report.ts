import { type SandboxResult } from "./sandbox-result";
import { type SerializedToolResult } from "./tool";

/** Why execution stopped observing a dispatched call, not the tool's external outcome. */
export type InterruptionReason =
  | "cancelled"
  | "timeout"
  | "script-error"
  | "sandbox-error"
  | "call-limit"
  | "concurrency-limit";

/** Parent observations, not proof of external side effects or guest receipt. */
export type CallOutcome = {
  readonly callId: number;
  readonly name: string;
} & (
  | { readonly status: "completed"; readonly result: SerializedToolResult }
  | { readonly status: "interrupted"; readonly reason: InterruptionReason }
);

type PendingCall = { readonly callId: number; readonly name: string; readonly status: "pending" };

export type ExecutionReport = {
  readonly result: SandboxResult;
  readonly calls: readonly CallOutcome[];
};

/** Host-only infrastructure failure. The cause preserves setup, transport, or cleanup failures. */
export class SandboxExecutionError extends Error {
  constructor(
    readonly calls: readonly CallOutcome[],
    cause: unknown,
  ) {
    super("Sandbox execution infrastructure failed.", { cause });
    this.name = "SandboxExecutionError";
  }
}

/** @internal Parent-owned records. Closing fixes the snapshot before abort listeners can run. */
export function createCallLog() {
  const calls = new Map<number, PendingCall | Extract<CallOutcome, { status: "completed" }>>();
  let snapshot: readonly CallOutcome[] | undefined;

  return {
    dispatch(callId: number, name: string) {
      if (snapshot !== undefined) return;

      calls.set(callId, { callId, name, status: "pending" });
    },
    complete(callId: number, result: SerializedToolResult) {
      if (snapshot !== undefined) return;

      const call = calls.get(callId);
      if (call === undefined) throw new Error("Cannot complete an undispatched sandbox call.");

      calls.set(callId, { ...call, status: "completed", result });
    },
    close(reason: InterruptionReason) {
      snapshot ??= [...calls.values()].map((call): CallOutcome => {
        if (call.status === "completed") return call;

        return { ...call, status: "interrupted", reason };
      });
      calls.clear();

      return snapshot;
    },
  };
}
