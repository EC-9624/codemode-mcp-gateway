import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

/** Synthetic upstream owned by the MCP tests. */
export function createMcpServer() {
  const server = new McpServer({ name: "cmg-test-upstream", version: "0.0.0" });

  server.registerTool(
    "add",
    {
      description: "Add two numbers",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      outputSchema: z.object({ sum: z.number() }),
    },
    ({ a, b }) => ({
      content: [{ type: "text", text: JSON.stringify({ sum: a + b }) }],
      structuredContent: { sum: a + b },
    }),
  );

  server.registerTool(
    "dataset",
    {
      description: "Return synthetic records for processing inside the sandbox",
      inputSchema: z.object({ count: z.number().int().min(0).max(10_000) }),
    },
    ({ count }) => ({
      content: [],
      structuredContent: {
        records: Array.from({ length: count }, (_, id) => ({ id, text: "x".repeat(100) })),
      },
    }),
  );

  return server;
}
