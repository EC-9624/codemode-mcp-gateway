import { type ToolException } from "@codemode-mcp-gateway/codemode";

/** SDK errors may contain private causes; log only a controlled session diagnostic. */
export function reportServerError(): void {
  console.error("CMG MCP session error.");
}

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
