import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

/** Synthetic upstream owned by the gateway tests. */
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

  return server;
}
