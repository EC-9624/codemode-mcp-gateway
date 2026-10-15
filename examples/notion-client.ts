import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const options = argumentsOf(process.argv.slice(2));
if (!options.ok) {
  console.error(options.message);
  process.exit(1);
}

const { configuration, query, page, marker, runs, agents, gateway } = options.value;

const check = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("passed"),
    summary: z.record(z.string(), z.union([z.number().nonnegative(), z.boolean()])),
  }),
  z.object({
    status: z.literal("failed"),
    kind: z.enum(["upstream", "validation"]),
    message: z.string(),
  }),
]);

const envelope = z.object({
  result: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value: check }),
    z.object({
      ok: z.literal(false),
      error: z.object({ kind: z.string(), resource: z.string().optional() }),
    }),
  ]),
});

// Keep provider bodies in the guest. Only counts and validation outcomes leave it.
const decoder = `
  function invalid(message) { return { status: "failed", kind: "validation", message }; }
  function decode(response) {
    if (response.isError) return { status: "failed", kind: "upstream", message: "Notion returned a tool error." };
    if (!Array.isArray(response.content) || response.content.length !== 1 || response.content[0].type !== "text") {
      return invalid("Expected one Notion JSON text block.");
    }
    let value;
    try { value = JSON.parse(response.content[0].text); }
    catch { return invalid("Notion text was not JSON."); }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("Expected a Notion JSON object.");
    return { status: "passed", value };
  }
  function pageId(value) {
    if (typeof value !== "string") return undefined;
    return value.replace(/-/g, "").match(/[a-f0-9]{32}/i)?.[0].toLowerCase();
  }
`;

const steps = [
  {
    name: "discover",
    code: `const toolsFound = await tools.searchTools({ query: "notion search" });
      if (!Array.isArray(toolsFound.tools) || !toolsFound.tools.some(tool => tool.name === "notion-search")) {
        return { status: "failed", kind: "validation", message: "Discovery did not include notion-search." };
      }
      return { status: "passed", summary: { toolsFound: toolsFound.tools.length, totalMatches: toolsFound.total } };`,
  },
  ...["notion-search", ...(page === undefined ? [] : ["notion-fetch"])].map((name) => ({
    name: `describe:${name}`,
    code: `const description = await tools.describeTool({ name: ${JSON.stringify(name)} });
      const field = ${JSON.stringify(name === "notion-search" ? "query" : "id")};
      if (description?.name !== ${JSON.stringify(name)} || description.inputSchema?.type !== "object"
        || description.inputSchema.properties?.[field]?.type !== "string"
        || !description.inputSchema.required?.includes(field)) {
        return { status: "failed", kind: "validation", message: "Required Notion input schema changed." };
      }
      return { status: "passed", summary: { schemaValidated: true } };`,
  })),
  {
    name: "search",
    code: `${decoder}
      const response = await tools["notion-search"]({ query: ${JSON.stringify(query)}, page_size: 10, max_highlight_length: 0 });
      const decoded = decode(response);
      if (decoded.status === "failed") return decoded;
      const value = decoded.value;
      if (value.type !== "workspace_search" || !Array.isArray(value.results)
        || !value.results.every(item => item !== null && typeof item === "object"
          && typeof item.id === "string" && typeof item.title === "string" && typeof item.url === "string")) {
        return invalid("Notion search result shape changed.");
      }
      const expectedPage = ${JSON.stringify(page ?? null)};
      if (expectedPage !== null && !value.results.some(item => pageId(item.id) === pageId(expectedPage))) {
        return invalid("Expected page was not in the first 10 search results. Use a more specific query.");
      }
      return { status: "passed", summary: { results: value.results.length, upstreamJsonCharacters: JSON.stringify(response).length } };`,
  },
];

if (page !== undefined) {
  steps.push({
    name: "fetch",
    code: `${decoder}
      const response = await tools["notion-fetch"]({ id: ${JSON.stringify(page)} });
      const decoded = decode(response);
      if (decoded.status === "failed") return decoded;
      const value = decoded.value;
      if (typeof value.title !== "string" || typeof value.url !== "string" || typeof value.text !== "string") {
        return invalid("Notion fetch result shape changed.");
      }
      if (pageId(value.url) !== pageId(${JSON.stringify(page)})) return invalid("Fetch returned a different page.");
      if (value.text.length === 0) return invalid("Fetched page text was empty.");
      const marker = ${JSON.stringify(marker ?? null)};
      if (marker !== null && !value.text.includes(marker)) return invalid("Expected marker was absent from the fetched page.");
      return { status: "passed", summary: { markerChecked: marker !== null, textCharacters: value.text.length, upstreamJsonCharacters: JSON.stringify(response).length } };`,
  });
}

console.log(
  JSON.stringify({
    step: "environment",
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    runs,
    agents,
    fetchRequested: page !== undefined,
    markerRequested: marker !== undefined,
  }),
);

const started = performance.now();

const child = spawn(
  gateway === undefined ? process.execPath : resolve(gateway),
  gateway === undefined
    ? [
        "--conditions=development",
        fileURLToPath(new URL("../packages/gateway/src/cli.ts", import.meta.url)),
        resolve(configuration),
      ]
    : [resolve(configuration)],
  { stdio: ["pipe", "pipe", "inherit"] },
);

const closed = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
child.once("close", (code, signal) => closed.resolve({ code, signal }));
let spawnFailed = false;
child.once("error", () => {
  spawnFailed = true;
});
const client = new Client({ name: "cmg-notion-smoke", version: "0.0.0" });
// Own the child directly: the SDK client transport can escalate to forced termination.
const transport = new StdioServerTransport(child.stdout, child.stdin);
await using cleanup = new AsyncDisposableStack();
cleanup.defer(async () => {
  const stopping = performance.now();
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 10_000);
  child.stdin.end();
  const exit = await closed.promise;
  clearTimeout(watchdog);
  await client.close();
  const passed = !spawnFailed && exit.code === 0 && exit.signal === null;
  console.log(
    JSON.stringify({
      step: "shutdown",
      status: passed ? "passed" : "failed",
      elapsedMs: performance.now() - stopping,
      ...exit,
    }),
  );
  if (!passed) process.exitCode = 1;
});

try {
  await client.connect(transport, { timeout: 30_000 });
} catch {
  console.log(
    JSON.stringify({
      step: "startup",
      status: "failed",
      kind: "transport",
      message:
        "Gateway initialization failed. See gateway diagnostics; if authorization is missing or rejected, run cmg login with this configuration.",
    }),
  );
  process.exitCode = 1;
}

if (process.exitCode !== 1) {
  console.log(
    JSON.stringify({ step: "startup", status: "passed", elapsedMs: performance.now() - started }),
  );
  for (let iteration = 1; iteration <= runs; iteration++) {
    // Multiplex independent workflows over this connection so they share one executor.
    await Promise.all(
      Array.from({ length: agents }, async (_, index) => {
        for (const step of steps) {
          const passed = await runStep(step.name, step.code, iteration, index + 1);
          if (!passed) break;
        }
      }),
    );

    if (process.exitCode === 1) break;
  }
}

async function runStep(step: string, code: string, iteration: number, agent: number) {
  const start = performance.now();
  let response;
  try {
    response = await client.callTool({ name: "execute", arguments: { code } }, { timeout: 60_000 });
  } catch {
    console.log(
      JSON.stringify({
        step,
        iteration,
        agent,
        status: "failed",
        kind: "transport",
        message: "MCP execution request failed.",
      }),
    );
    process.exitCode = 1;

    return false;
  }

  const parsed = envelope.safeParse(response.structuredContent);

  const timing = {
    elapsedMs: performance.now() - start,
    responseJsonBytes: Buffer.byteLength(JSON.stringify(response), "utf8"),
  };

  if (!parsed.success) {
    console.log(
      JSON.stringify({
        step,
        iteration,
        agent,
        ...timing,
        status: "failed",
        kind: "validation",
        message: "Gateway response shape changed.",
      }),
    );
    process.exitCode = 1;

    return false;
  }

  const result = parsed.data.result;
  if (!result.ok || response.isError) {
    console.log(
      JSON.stringify({
        step,
        iteration,
        agent,
        ...timing,
        status: "failed",
        kind: "execution",
        message: "Guest execution failed.",
        executionKind: result.ok ? "protocol" : result.error.kind,
        executionResource: result.ok ? undefined : result.error.resource,
      }),
    );
    process.exitCode = 1;

    return false;
  }

  console.log(JSON.stringify({ step, iteration, agent, ...timing, ...result.value }));
  if (result.value.status === "failed") process.exitCode = 1;

  return result.value.status === "passed";
}

function argumentsOf(args: string[]) {
  const usage =
    "Usage: bun run example:notion <config> <query> [page URL or id] [--page <url-or-id>] [--expect <marker>] [--runs <1-20>] [--agents <1-8>] [--gateway <installed-cmg-path>]";

  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        page: { type: "string" },
        expect: { type: "string" },
        runs: { type: "string", default: "1" },
        agents: { type: "string", default: "1" },
        gateway: { type: "string" },
      },
    });
  } catch {
    return { ok: false, message: usage } as const;
  }

  const [configuration, query, legacyPage] = parsed.positionals;
  const page = parsed.values.page ?? legacyPage;
  const marker = parsed.values.expect;
  const runs = Number(parsed.values.runs);
  const agents = Number(parsed.values.agents);
  const gateway = parsed.values.gateway;
  if (
    !configuration ||
    !query?.trim() ||
    (gateway !== undefined && !gateway.trim()) ||
    parsed.positionals.length > 3 ||
    (legacyPage !== undefined && parsed.values.page !== undefined) ||
    (page !== undefined && !page.replace(/-/g, "").match(/[a-f0-9]{32}/i)) ||
    (marker !== undefined && (!marker.trim() || page === undefined)) ||
    !Number.isInteger(runs) ||
    runs < 1 ||
    runs > 20 ||
    !Number.isInteger(agents) ||
    agents < 1 ||
    agents > 8
  ) {
    return { ok: false, message: usage } as const;
  }

  return {
    ok: true,
    value: { configuration, query, page, marker, runs, agents, gateway },
  } as const;
}
