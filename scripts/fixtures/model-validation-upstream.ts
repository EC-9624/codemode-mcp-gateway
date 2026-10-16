import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const audit = z.string().min(1).parse(process.argv[2]);

const workflow = z.enum(["alpha", "bravo", "charlie", "delta"]);
const arrivals = new Set<string>();
const gate = Promise.withResolvers<void>();
let active = 0;
record("started");
process.on("exit", () => record("exit"));

serveStdio(() => {
  const server = new McpServer({ name: "model-validation-documents", version: "1" });
  server.registerTool(
    "search",
    {
      description:
        "Find your workflow's document. All four workflows must arrive before search returns; call once.",
      inputSchema: z.object({ workflow }),
    },
    async ({ workflow }) => {
      if (arrivals.has(workflow)) throw new Error("Workflow search was replayed");

      arrivals.add(workflow);
      active++;
      record("search-start", { workflow, active });
      if (arrivals.size === 4) gate.resolve();

      await gate.promise;
      active--;
      record("search-return", { workflow, active });

      return text(JSON.stringify({ id: workflow, verificationLine: 3002 }));
    },
  );
  server.registerTool(
    "fetch",
    {
      description:
        "Fetch a large Unicode document. The verification record is on line 3002, outside its preview. Return the text without projecting it to exercise saved output.",
      inputSchema: z.object({ id: workflow }),
    },
    ({ id }) => {
      record("fetch", { workflow: id });

      return text(
        [
          `document:${id}`,
          ...Array.from({ length: 3000 }, () => "Synthetic local document filler 日😀"),
          `verification:${id}:${crypto.randomUUID()}`,
          ...Array.from({ length: 3000 }, () => "Synthetic local document filler 日😀"),
          `end:${id}`,
        ].join("\n"),
      );
    },
  );
  server.registerTool(
    "unavailable",
    {
      description: "Return one deliberate actionable public failure. Do not retry it.",
      inputSchema: z.object({ workflow }),
    },
    ({ workflow }) => {
      record("unavailable", { workflow });

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

  return server;
});

function text(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function record(event: string, fields: Record<string, unknown> = {}) {
  appendFileSync(audit, JSON.stringify({ event, pid: process.pid, ...fields }) + "\n");
}
