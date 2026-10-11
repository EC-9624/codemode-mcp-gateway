import { type StandardSchemaV1 } from "@standard-schema/spec";

export type ToolResult = { ok: true; value: unknown } | { ok: false; error: { message: string } };

/** Only explicit failure messages cross into the guest; thrown errors stay private. */
export const ToolResult = {
  success(value?: unknown) {
    return { ok: true, value } satisfies ToolResult;
  },
  failure(message: string) {
    return { ok: false, error: { message } } satisfies ToolResult;
  },
} as const;

/** Host-only execution context. Cancellation is cooperative; it does not undo side effects. */
export type ToolContext = { readonly signal: AbortSignal };

export type SandboxTool = (args: unknown, context: ToolContext) => ToolResult | Promise<ToolResult>;

/** Bind typed validation to an unknown-input callback without erasing the handler's output type. */
export function validateTool<Input, Output>(
  schema: StandardSchemaV1<Input, Output>,
  execute: (args: Output, context: ToolContext) => ToolResult | Promise<ToolResult>,
  name?: string,
): SandboxTool {
  return async (args, context) => {
    context.signal.throwIfAborted();
    const result = await schema["~standard"].validate(args);
    // Standard Schema has no cancellation parameter; late validation must never dispatch work.
    context.signal.throwIfAborted();
    if (result.issues) {
      const issue = result.issues[0];

      const path = issue?.path?.map((segment) => {
        const key = typeof segment === "object" ? segment.key : segment;

        return String(key).replace(/~/g, "~0").replace(/\//g, "~1");
      });

      const location = path?.length ? `/${path.join("/")}: ` : "";
      const tool = name === undefined ? "" : ` for ${JSON.stringify(name)}`;

      return ToolResult.failure(
        `Invalid arguments${tool}: ${location}${issue?.message ?? "Input does not match its schema."}`,
      );
    }

    return execute(result.value, context);
  };
}

/** Raw structured cloning would bypass toJSON and change the guest's JSON semantics. */
export type SerializedToolResult =
  | { readonly ok: true; readonly json: string | undefined }
  | { readonly ok: false; readonly error: { readonly message: string } };

export function serializeToolResult(result: ToolResult): SerializedToolResult {
  // Forwarding the original envelope could transport extra private fields or callbacks.
  if (!result.ok) return ToolResult.failure(result.error.message);

  let value: unknown;
  let serialized: string | undefined;
  try {
    value = result.value;
    serialized = JSON.stringify(value);
  } catch {
    // Getters and toJSON are part of conversion and can throw arbitrary values.
    return ToolResult.failure("Tool result is not JSON-serializable.");
  }

  if (serialized === undefined && value !== undefined) {
    return ToolResult.failure("Tool result is not JSON-serializable.");
  }

  return { ok: true, json: serialized };
}

export async function callTool(
  tool: SandboxTool,
  args: unknown,
  context: ToolContext,
): Promise<ToolResult> {
  try {
    return await tool(args, context);
  } catch {
    return ToolResult.failure("Host tool failed.");
  }
}
