import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const workflows = z.enum(["alpha", "bravo", "charlie", "delta"]);
const arrivals = new Set<string>();
const release = Promise.withResolvers<void>();
const counts = { search: 0, fetch: 0, unavailable: 0 };
let active = 0;
let peak = 0;

console.error(`agent-validation-pid:${process.pid}`);
process.on("exit", () => console.error("agent-validation-exit"));

serveStdio(() => {
  const server = new McpServer({ name: "agent-validation-fixture", version: "1" });
  server.registerTool(
    "search",
    {
      description: "Search validation documents; four distinct workflows release the arrival gate.",
      inputSchema: z.object({ workflow: workflows }),
    },
    async ({ workflow }) => {
      counts.search++;
      if (arrivals.has(workflow)) throw new Error("A workflow search was replayed.");

      arrivals.add(workflow);
      active++;
      peak = Math.max(peak, active);
      if (arrivals.size === 4) release.resolve();

      // No timer simulates overlap: all four requests must enter before any can finish.
      await release.promise;
      active--;

      return text({ id: workflow, marker: `document:${workflow}`, overlappingSearches: peak });
    },
  );
  server.registerTool(
    "fetch",
    {
      description: "Fetch one large single-line Unicode validation document.",
      inputSchema: z.object({ id: workflows }),
    },
    ({ id }) => {
      counts.fetch++;

      return text({ id, text: `document:${id}|${"日😀".repeat(45_000)}|end:${id}` });
    },
  );
  server.registerTool(
    "unavailable",
    {
      description: "Return a deliberate actionable public tool error.",
      inputSchema: z.object({ workflow: workflows }),
    },
    ({ workflow }) => {
      counts.unavailable++;

      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Document ${workflow} is unavailable. Choose another document ID.`,
          },
        ],
      };
    },
  );
  server.registerTool(
    "audit",
    { description: "Read compact fixture call counts and gate observations." },
    () => text({ counts, arrivals: [...arrivals].sort(), peak, active }),
  );

  return server;
});

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
