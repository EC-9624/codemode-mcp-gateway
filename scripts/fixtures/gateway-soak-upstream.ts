import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

/** Synthetic, read-only tools shared by the two real transport endpoints. */
export function createSoakUpstream() {
  const server = new McpServer({ name: "gateway-soak-upstream", version: "0" });
  const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const counts = { documents: 0, failures: 0, waits: 0, aborted: 0, returned: 0 };

  server.registerTool("document", {}, () => {
    counts.documents++;

    return { content: [], structuredContent: { text: "x".repeat(65_536) } };
  });
  server.registerTool("failure", {}, () => {
    counts.failures++;

    return { isError: true, content: [{ type: "text", text: "Synthetic public failure" }] };
  });
  server.registerTool("stats", {}, () => ({
    content: [],
    structuredContent: { ...counts, active: gates.size, pid: process.pid },
  }));
  server.registerTool("release", { inputSchema: z.object({ id: z.string() }) }, ({ id }) => {
    const gate = gates.get(id);
    if (gate === undefined) throw new Error("Unknown soak gate");

    gate.resolve();

    return { content: [] };
  });
  server.registerTool(
    "wait",
    { inputSchema: z.object({ id: z.string() }) },
    async ({ id }, { mcpReq }) => {
      if (gates.has(id)) throw new Error("Duplicate soak gate");

      const gate = Promise.withResolvers<void>();
      gates.set(id, gate);
      counts.waits++;

      const abort = () => {
        counts.aborted++;
        gate.resolve();
      };

      mcpReq.signal.addEventListener("abort", abort, { once: true });
      if (mcpReq.signal.aborted) abort();

      try {
        await gate.promise;

        return { content: [], structuredContent: { id } };
      } finally {
        mcpReq.signal.removeEventListener("abort", abort);
        gates.delete(id);
        counts.returned++;
      }
    },
  );

  return { server, counts, active: () => gates.size };
}

if (import.meta.main) serveStdio(() => createSoakUpstream().server);
