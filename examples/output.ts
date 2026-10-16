import { type CallToolResult } from "@modelcontextprotocol/client";

/** The MCP execute tool returns display text, not the executor's private report. */
export function responseText(response: CallToolResult): string {
  return response.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}
