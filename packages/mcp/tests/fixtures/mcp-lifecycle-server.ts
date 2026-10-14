import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "./mcp-tools.ts";

const mode = process.argv[2];

serveStdio(() => {
  const server = createMcpServer();
  if (mode === "discovery") {
    server.server.setRequestHandler("tools/list", async (_request, { mcpReq }) => {
      await waitForCancellation(mcpReq.signal);

      return { tools: [] };
    });
  }

  server.registerTool(
    "pending",
    { description: "Wait until the client cancels the request" },
    async ({ mcpReq }) => {
      await waitForCancellation(mcpReq.signal);

      return { content: [{ type: "text", text: "Late result" }] };
    },
  );

  return server;
});

async function waitForCancellation(signal: AbortSignal) {
  signal.throwIfAborted();

  using cleanup = new DisposableStack();
  const cancelled = Promise.withResolvers<void>();
  const abort = () => cancelled.resolve();
  cleanup.defer(() => signal.removeEventListener("abort", abort));
  signal.addEventListener("abort", abort, { once: true });
  console.error("request-started");
  await cancelled.promise;
  console.error("request-cancelled");
}
