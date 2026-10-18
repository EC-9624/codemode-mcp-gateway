/** SDK errors may contain private causes; log only a controlled session diagnostic. */
export function reportServerError(): void {
  console.error("CMG MCP session error.");
}
