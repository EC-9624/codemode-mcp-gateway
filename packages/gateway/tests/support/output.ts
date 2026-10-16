import { type CallToolResult } from "@modelcontextprotocol/client";

export function responseText(response: CallToolResult): string {
  return response.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

export function responseValue(response: CallToolResult): unknown {
  return JSON.parse(responseText(response));
}
