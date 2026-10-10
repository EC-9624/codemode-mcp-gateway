import { type QuickJSContext, type QuickJSDeferredPromise, type Scope } from "quickjs-emscripten";
import { type SerializedToolResult } from "./tool";

export { ToolResult, type SandboxTool } from "./tool";

export type ToolBridge = {
  pendingCalls: ReadonlySet<Promise<void>>;
  readonly failure: { ok: true } | { ok: false; error: unknown };
  failed: Promise<void>;
  fail(error: unknown): void;
};

/** Invocation rejects only for infrastructure failures, never ordinary tool failures. */
export function installToolBridge(
  context: QuickJSContext,
  names: readonly string[],
  invoke: (name: string, json: string | undefined) => Promise<SerializedToolResult>,
  scope: Scope,
): ToolBridge {
  const pending = new Set<Promise<void>>();
  const failed = Promise.withResolvers<void>();
  let failure: ToolBridge["failure"] = { ok: true };
  const fail = (error: unknown) => {
    if (!failure.ok) return;
    failure = { ok: false, error };
    failed.resolve();
  };
  using toolObject = context.newObject(context.null);

  for (const name of names) {
    using callback = context.newFunction(name, (args = context.undefined) => {
      const noArgs = context.typeof(args) === "undefined";
      if (!noArgs && context.typeof(args) !== "string") {
        return { error: context.newError("Tool arguments must be JSON text or undefined.") };
      }
      const json = noArgs ? undefined : context.getString(args);
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
      const deferred = scope.manage(context.newPromise());
      const invocation = settleTool(context, () => invoke(name, json), deferred, scope);
      pending.add(invocation);
      void invocation.then(() => pending.delete(invocation), fail);
      return deferred.handle;
    });
    context.setProp(toolObject, name, callback);
  }

  context.setProp(context.global, "tools", toolObject);
  return {
    pendingCalls: pending,
    get failure() {
      return failure;
    },
    failed: failed.promise,
    fail,
  };
}

async function settleTool(
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
