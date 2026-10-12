import { type CallOutcome, type InterruptionReason } from "../types.ts";
import { type SerializedToolResult } from "../tools.ts";

type PendingCall = { readonly callId: number; readonly name: string; readonly status: "pending" };

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
