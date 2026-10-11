import { type QuickJSContext, type QuickJSDeferredPromise, type Scope } from "quickjs-emscripten";
import { type SerializedToolResult } from "./tool";

export type ToolBridge = {
  pendingCalls: ReadonlySet<Promise<void>>;
  readonly failure: { ok: true } | { ok: false; error: unknown };
  failureSignal: Promise<void>;
  fail(error: unknown): void;
};

/**
 * Tool failures arrive as result values so guests can catch them.
 * Invocation rejections signal infrastructure failure and must end execution,
 * rather than become catchable guest errors.
 */
export function installGuestToolBridge(
  context: QuickJSContext,
  toolNames: readonly string[],
  invoke: (name: string, json: string | undefined) => Promise<SerializedToolResult>,
  scope: Scope,
): ToolBridge {
  const pendingCalls = new Set<Promise<void>>();
  const failureSignal = Promise.withResolvers<void>();
  let failure: ToolBridge["failure"] = { ok: true };

  const fail = (error: unknown) => {
    if (!failure.ok) return;

    failure = { ok: false, error };
    failureSignal.resolve();
  };

  using toolObject = context.newObject(context.null);

  for (const name of toolNames) {
    using callback = context.newFunction(name, (args = context.undefined) => {
      if (!failure.ok) return context.undefined;

      let json: string | undefined;
      let deferred: QuickJSDeferredPromise;

      try {
        const noArgs = context.typeof(args) === "undefined";

        if (!noArgs && context.typeof(args) !== "string") {
          return { error: context.newError("Tool arguments must be JSON text or undefined.") };
        }

        json = noArgs ? undefined : context.getString(args);
        // Relying on the public wrapper alone would leave raw bridge calls unchecked.
        if (json !== undefined) {
          try {
            JSON.parse(json);
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;

            return { error: context.newError("Tool arguments are not valid JSON.") };
          }
        }

        // Callback-local `using` would dispose the resolver before the host reply arrives.
        deferred = scope.manage(context.newPromise());
      } catch (error) {
        // Escaping this callback lets the SDK turn private exceptions into guest errors.
        fail(error);

        return context.undefined;
      }

      const settlement = settlePromise(context, () => invoke(name, json), deferred, scope);
      pendingCalls.add(settlement);
      void settlement.then(() => pendingCalls.delete(settlement), fail);

      return deferred.handle;
    });

    context.setProp(toolObject, name, callback);
  }

  context.setProp(context.global, "tools", toolObject);

  return {
    pendingCalls,
    get failure() {
      return failure;
    },
    failureSignal: failureSignal.promise,
    fail,
  };
}

async function settlePromise(
  context: QuickJSContext,
  invoke: () => Promise<SerializedToolResult>,
  deferred: QuickJSDeferredPromise,
  scope: Scope,
): Promise<void> {
  const result = await invoke();
  if (!scope.alive) return;

  if (!result.ok) {
    using guestError = context.newError(result.error.message);
    deferred.reject(guestError);

    return;
  }

  if (result.json === undefined) {
    deferred.resolve();

    return;
  }

  // Allocation/settlement exceptions stay infrastructure failures; never retry the VM.
  using json = context.newString(result.json);
  deferred.resolve(json);
}
