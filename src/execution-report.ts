import { type SandboxResult } from "./sandbox-result";
import { type SerializedToolResult } from "./tool";

/** Parent observations, not proof of external side effects or guest receipt. */
export type CallOutcome = {
  readonly callId: number;
  readonly name: string;
} & (
  | { readonly status: "completed"; readonly result: SerializedToolResult }
  | { readonly status: "uncertain" }
);

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
  const calls = new Map<number, CallOutcome>();
  let snapshot: readonly CallOutcome[] | undefined;

  return {
    dispatch(callId: number, name: string) {
      if (snapshot !== undefined) return;

      calls.set(callId, { callId, name, status: "uncertain" });
    },
    complete(callId: number, result: SerializedToolResult) {
      if (snapshot !== undefined) return;

      const call = calls.get(callId);
      if (call === undefined) throw new Error("Cannot complete an undispatched sandbox call.");

      calls.set(callId, { ...call, status: "completed", result });
    },
    close() {
      snapshot ??= [...calls.values()];
      calls.clear();

      return snapshot;
    },
  };
}
