import { type ToolException } from "@codemode-mcp-gateway/codemode";

/** Host-only projection: never serialize the original error object or its response data. */
export function reportToolException(exception: ToolException): void {
  const cause = exception.cause;

  console.error(
    JSON.stringify({
      tool: exception.name,
      callId: exception.callId,
      error:
        cause instanceof Error
          ? {
              name: cause.name,
              message: cause.message,
              ...("code" in cause ? { code: cause.code } : {}),
            }
          : { name: typeof cause },
    }),
  );
}
