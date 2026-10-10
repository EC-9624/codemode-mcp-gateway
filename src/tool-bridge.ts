import { type QuickJSContext, type QuickJSDeferredPromise, type Scope } from "quickjs-emscripten";

export type ToolResult = { ok: true; value: unknown } | { ok: false; error: { message: string } };

/** Only explicit failure messages cross into the guest; thrown errors stay private. */
export const ToolResult = {
  success(value?: unknown): ToolResult {
    return { ok: true, value };
  },
  failure(message: string): ToolResult {
    return { ok: false, error: { message } };
  },
} as const;

export type SandboxTool = (args: unknown) => ToolResult | Promise<ToolResult>;

type CodecResult<T> = { ok: true; value: T } | { ok: false; message: string };

export type ToolBridge = {
  pendingCalls: ReadonlySet<Promise<void>>;
  readonly failure: { ok: true } | { ok: false; error: unknown };
};

export function installTools(
  context: QuickJSContext,
  tools: Readonly<Record<string, SandboxTool>>,
  scope: Scope,
): ToolBridge {
  const pending = new Set<Promise<void>>();
  let failure: ToolBridge["failure"] = { ok: true };
  using toolObject = context.newObject(context.null);

  for (const [name, tool] of Object.entries(tools)) {
    using callback = context.newFunction(name, (args = context.undefined) => {
      const noArgs = context.typeof(args) === "undefined";
      if (!noArgs && context.typeof(args) !== "string") {
        return { error: context.newError("Tool arguments must be JSON text or undefined.") };
      }

      const input: CodecResult<unknown> = noArgs
        ? { ok: true, value: undefined }
        : parseToolArguments(context.getString(args));
      if (!input.ok) return { error: context.newError(input.message) };
      // Do not use a callback-local `using`: the resolver must survive its return.
      const deferred = scope.manage(context.newPromise());
      const invocation = invokeTool(context, tool, input.value, deferred, scope);
      pending.add(invocation);
      void invocation.then(
        () => pending.delete(invocation),
        // Observe infrastructure failures even while guest jobs keep arriving.
        (error: unknown) => {
          if (failure.ok) failure = { ok: false, error };
        },
      );
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
  };
}

async function invokeTool(
  context: QuickJSContext,
  tool: SandboxTool,
  args: unknown,
  deferred: QuickJSDeferredPromise,
  scope: Scope,
): Promise<void> {
  const result = await callTool(tool, args);
  // Timeout/failure can close the VM before the host operation settles.
  if (!scope.alive) return;

  if (!result.ok) {
    using guestError = context.newError(result.error.message);
    deferred.reject(guestError);
    return;
  }

  const serialized = serializeToolResult(result.value);
  if (!serialized.ok) {
    using guestError = context.newError(serialized.message);
    deferred.reject(guestError);
    return;
  }
  if (serialized.value === undefined) {
    deferred.resolve();
    return;
  }

  // VM allocation and settlement failures must reject the host invocation, not
  // be caught as tool failures or followed by another attempt to use the VM.
  using json = context.newString(serialized.value);
  deferred.resolve(json);
}

async function callTool(tool: SandboxTool, args: unknown): Promise<ToolResult> {
  try {
    return await tool(args);
  } catch {
    return ToolResult.failure("Host tool failed.");
  }
}

function parseToolArguments(json: string): CodecResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(json) };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { ok: false, message: "Tool arguments are not valid JSON." };
  }
}

function serializeToolResult(value: unknown): CodecResult<string | undefined> {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    // Getters and toJSON are part of conversion and can throw arbitrary values.
    return { ok: false, message: "Tool result is not JSON-serializable." };
  }
  if (serialized === undefined && value !== undefined) {
    return { ok: false, message: "Tool result is not JSON-serializable." };
  }
  return { ok: true, value: serialized };
}
