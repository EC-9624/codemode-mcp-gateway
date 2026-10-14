import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "./mcp-tools.ts";

console.error(`upstream-pid:${process.pid}`);
process.on("exit", () => console.error("upstream-exit"));
const mode = process.argv[2];

serveStdio(() => {
  const server = createMcpServer();
  // Startup stalls and malformed catalog responses need raw protocol handlers;
  // ordinary tools below use the supported registration API.
  if (mode === "initialize") {
    server.server.setRequestHandler("initialize", async ({ params }, { mcpReq }) => {
      await waitForCancellation(mcpReq.signal);

      return {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "stalled", version: "1" },
      };
    });
  }

  if (mode === "discovery") {
    server.server.setRequestHandler("tools/list", async (_request, { mcpReq }) => {
      await waitForCancellation(mcpReq.signal);

      return { tools: [] };
    });
  }

  if (mode === "invalid-schema") {
    server.server.setRequestHandler("tools/list", () => ({
      tools: [{ name: "invalid", inputSchema: { type: "object", required: ["x", "x"] } }],
    }));
  }

  if (mode === "collision") {
    server.registerTool("searchTools", {}, () => ({ content: [] }));
  }

  server.registerTool("pending", {}, async ({ mcpReq }) => {
    await waitForCancellation(mcpReq.signal);

    return { content: [] };
  });
  server.registerTool("started", {}, () => {
    console.error("request-started");

    return { content: [] };
  });

  return server;
});

async function waitForCancellation(signal: AbortSignal): Promise<void> {
  using cleanup = new DisposableStack();
  const stopped = Promise.withResolvers<void>();
  const abort = () => stopped.resolve();
  signal.addEventListener("abort", abort, { once: true });
  cleanup.defer(() => signal.removeEventListener("abort", abort));
  signal.throwIfAborted();
  console.error("request-started");
  await stopped.promise;
  console.error("request-cancelled");
}
