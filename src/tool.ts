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

export type SandboxTool = (args: unknown) => ToolResult | Promise<ToolResult>;

/** Raw structured cloning would bypass toJSON and change the guest's JSON semantics. */
export type SerializedToolResult =
  | { ok: true; json: string | undefined }
  | { ok: false; error: { message: string } };

export function serializeToolResult(result: ToolResult): SerializedToolResult {
  // Forwarding the original envelope could transport extra private fields or callbacks.
  if (!result.ok) return ToolResult.failure(result.error.message);

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(result.value);
  } catch {
    // Getters and toJSON are part of conversion and can throw arbitrary values.
    return ToolResult.failure("Tool result is not JSON-serializable.");
  }
  if (serialized === undefined && result.value !== undefined) {
    return ToolResult.failure("Tool result is not JSON-serializable.");
  }
  return { ok: true, json: serialized };
}

export async function callTool(tool: SandboxTool, args: unknown): Promise<ToolResult> {
  try {
    return await tool(args);
  } catch {
    return ToolResult.failure("Host tool failed.");
  }
}
