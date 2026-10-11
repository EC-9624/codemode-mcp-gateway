import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

/** One synthetic upstream shared by the stdio example and focused integration tests. */
export function createMcpServer() {
  const server = new McpServer({ name: "mcm-example", version: "0.0.0" });

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

  server.registerTool("fail", { description: "Return an explicit public tool error" }, () => ({
    content: [{ type: "text", text: "Synthetic tool failure." }],
    isError: true,
  }));

  server.registerTool(
    "wait",
    {
      description: "Wait for a duration, stopping cooperatively when cancelled",
      inputSchema: z.object({ milliseconds: z.number().int().min(0).max(60_000) }),
    },
    async ({ milliseconds }, { mcpReq }) => {
      mcpReq.signal.throwIfAborted();

      using cleanup = new DisposableStack();
      const completed = Promise.withResolvers<void>();
      const abort = () => completed.reject(new Error("Synthetic wait cancelled."));
      cleanup.defer(() => mcpReq.signal.removeEventListener("abort", abort));
      mcpReq.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => completed.resolve(), milliseconds);
      cleanup.defer(() => clearTimeout(timer));
      await completed.promise;

      return { content: [{ type: "text", text: "Wait completed." }] };
    },
  );

  return server;
}
