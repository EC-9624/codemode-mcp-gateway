/**
 * Worker side of the private guest protocol. One native dispatcher receives JSON
 * call envelopes; ordinary guest promises and their resolvers stay in the prelude.
 * The supplied scope owns the dispatcher and the settlement handle, not this object.
 *
 * Calls are validated and admitted before dispatch; excess concurrency waits in FIFO order.
 * A reply settles its guest promise, releases an active slot, dispatches the next queued
 * call, and wakes the engine. Decoding runs later on the guest job queue, so a then
 * getter can safely start another call after the previous call releases its slot.
 *
 * The first admission limit or infrastructure failure stops the bridge. Exceptions
 * must be recorded here: letting them escape a native callback would make the SDK
 * expose them as catchable guest errors instead of terminal infrastructure failures.
 */
import { type QuickJSContext, type QuickJSHandle, type Scope } from "quickjs-emscripten";
import { type ToolCallLimit } from "../types.ts";
import { createToolCallBudget, type ToolCallLimits } from "./budget.ts";
import { GuestCall, GuestReply, ToolReply } from "./protocol.ts";

/** Private infrastructure failures throw; admission limits are guest results. */
export type BridgeFailure =
  | { kind: "error"; error: unknown }
  | { kind: "limit"; limit: ToolCallLimit };

export type ToolBridge = {
  /** Borrowed from the execution's scope; callers must not dispose it separately. */
  readonly dispatcher: QuickJSHandle;
  readonly toolNames: readonly string[];
  readonly pendingCalls: ReadonlySet<number>;
  /** Renewed after each settled reply; read the current promise before waiting. */
  readonly changeSignal: Promise<void>;
  /** The first failure wins; it stays undefined while the bridge is healthy. */
  readonly failure: BridgeFailure | undefined;
  readonly failureSignal: Promise<void>;
  /** Borrows the prelude API and adds an owned settlement handle to the supplied scope. */
  attach(api: QuickJSHandle): void;
  receive(reply: unknown): void;
  fail(error: unknown): void;
};

/**
 * Owns one native dispatcher and a private settlement handle in the supplied scope.
 * Guest promises live in the prelude. Dispatch must not synchronously re-enter the VM.
 */
export function installGuestToolBridge(
  context: QuickJSContext,
  toolNames: readonly string[],
  dispatch: (call: GuestCall) => void,
  scope: Scope,
  limits: ToolCallLimits,
): ToolBridge {
  const names = new Set(toolNames);
  const budget = createToolCallBudget(limits);
  const pendingCalls = new Set<number>();
  const activeCalls = new Set<number>();
  const queuedCalls: GuestCall[] = [];
  const failureSignal = Promise.withResolvers<void>();
  let change = Promise.withResolvers<void>();
  let failure: BridgeFailure | undefined;
  let settle: QuickJSHandle | undefined;
  let lastCallId = 0;

  const notify = () => {
    change.resolve();
    change = Promise.withResolvers<void>();
  };

  const stop = (next: BridgeFailure) => {
    if (failure !== undefined) return;

    failure = next;
    queuedCalls.length = 0;
    failureSignal.resolve();
  };

  const fail = (error: unknown) => stop({ kind: "error", error });

  const dispatchNext = () => {
    if (!scope.alive || failure !== undefined) return;

    const call = queuedCalls[0];
    // A full active budget leaves the call queued, not failed. Admission already
    // charged it against the total budget, so queueing cannot bypass the call limit.
    if (call === undefined || budget.start() !== undefined) return;

    queuedCalls.shift();
    activeCalls.add(call.callId);
    dispatch(call);
  };

  const dispatcher = scope.manage(
    context.newFunction("dispatch", (json = context.undefined) => {
      if (failure !== undefined) return context.false;

      try {
        const decoded = GuestCall.decode(
          context.typeof(json) === "string" ? context.getString(json) : undefined,
        );

        if (!decoded.ok) {
          fail(new Error(decoded.message));

          return context.false;
        }

        const call = decoded.value;
        if (!names.has(call.name) || call.callId !== lastCallId + 1) {
          fail(new Error("Sandbox guest requested an unknown tool or invalid call ID."));

          return context.false;
        }

        const limit = budget.admit();
        if (limit !== undefined) {
          stop({ kind: "limit", limit });

          return context.false;
        }

        lastCallId = call.callId;
        pendingCalls.add(call.callId);
        queuedCalls.push(call);
        dispatchNext();

        return context.true;
      } catch (error) {
        // The SDK turns escaping native callback exceptions into guest-visible errors.
        fail(error);
      }

      return context.false;
    }),
  );

  return {
    dispatcher,
    toolNames,
    pendingCalls,
    get changeSignal() {
      return change.promise;
    },
    get failure() {
      return failure;
    },
    failureSignal: failureSignal.promise,
    attach(api) {
      if (settle !== undefined) throw new Error("Sandbox guest bridge is already initialized.");

      settle = scope.manage(context.getProp(api, "settle"));
    },
    receive(reply) {
      if (!scope.alive || failure !== undefined) return;

      try {
        const decoded = ToolReply.decode(reply);
        if (!decoded.ok) {
          fail(new Error(decoded.message));

          return;
        }

        if (!activeCalls.has(decoded.value.callId)) {
          fail(new Error("Sandbox worker received an unknown or duplicate tool reply."));

          return;
        }

        if (settle === undefined) throw new Error("Sandbox guest bridge is not initialized.");

        using json = context.newString(GuestReply.encode(decoded.value));
        using result = context.callFunction(settle, context.undefined, json);
        if (result.error) throw new Error("Sandbox guest settlement failed.");

        pendingCalls.delete(decoded.value.callId);
        activeCalls.delete(decoded.value.callId);
        budget.release();
        dispatchNext();
        notify();
      } catch (error) {
        // A broken settlement is terminal, never retried as a guest tool rejection.
        fail(error);
      }
    },
    fail,
  };
}
