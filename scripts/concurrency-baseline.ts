import { deepStrictEqual, strictEqual } from "node:assert";
import { cpus, release } from "node:os";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpCatalog } from "@cmg/mcp";
import { Configuration, createServer } from "codemode-mcp-gateway";
import { z } from "zod";

const waves = Number(process.argv[2] ?? 5);
if (process.argv.length > 4 || !Number.isInteger(waves) || waves < 2 || waves > 20) {
  console.error("Usage: bun run baseline:concurrency [waves-per-scenario: 2-20]");
  process.exit(1);
}

const scenarioSchema = z.object({
  agents: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]),
  limit: z.union([z.literal(4), z.literal(8)]),
  cadence: z.enum(["burst", "staggered"]),
});

type Scenario = z.infer<typeof scenarioSchema>;
type Sample = { step: string; elapsedMs: number; status: "completed" | "rejected" };

const envelope = z.object({
  result: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value: z.unknown() }),
    z.object({
      ok: z.literal(false),
      error: z.object({
        kind: z.literal("limit"),
        resource: z.literal("executions"),
        maximum: z.number(),
      }),
    }),
  ]),
  calls: z.array(
    z.strictObject({ callId: z.number(), name: z.string(), status: z.literal("completed") }),
  ),
});

const steps = [
  {
    name: "discover",
    code: 'return (await tools.searchTools({ query: "documents" })).tools.map(tool => tool.name).sort();',
    expected: ["fetch", "search"],
    calls: ["searchTools"],
  },
  {
    name: "describe",
    code: `return await Promise.all(["search", "fetch"].map(async name => {
      const tool = await tools.describeTool({ name });
      return tool.inputSchema.type;
    }));`,
    expected: ["object", "object"],
    calls: ["describeTool", "describeTool"],
  },
  {
    name: "search",
    code: `const response = await tools.search({ query: "design" });
      if (response.isError) throw new Error("Search failed");
      return JSON.parse(response.content[0].text).ids;`,
    expected: ["guide", "design"],
    calls: ["search"],
  },
  {
    name: "fetch",
    code: `return await Promise.all(["guide", "design"].map(async id => {
      const response = await tools.fetch({ id });
      if (response.isError) throw new Error("Fetch failed");
      const page = JSON.parse(response.content[0].text);
      return { id: page.id, characters: page.text.length };
    }));`,
    expected: [
      { id: "guide", characters: 65_536 },
      { id: "design", characters: 65_536 },
    ],
    calls: ["fetch", "fetch"],
  },
];

const childScenario = process.argv[3];
if (childScenario !== undefined) {
  await measure(scenarioSchema.parse(JSON.parse(childScenario)));
} else {
  console.log(
    JSON.stringify({
      phase: "environment",
      bun: Bun.version,
      revision: Bun.revision,
      platform: process.platform,
      arch: process.arch,
      osRelease: release(),
      cpu: cpus()[0]?.model,
      waves,
      searchDelayMs: 150,
      fetchDelayMs: 300,
      documentCharacters: 65_536,
      thinkMs: 100,
      staggerMs: 150,
      rssSampleIntervalMs: 5,
      topology:
        "simulated agents multiplexed over one in-memory MCP connection to one gateway; local MCP upstream",
    }),
  );
  for (const cadence of ["burst", "staggered"] as const) {
    for (const load of [
      { agents: 1, limit: 4 },
      { agents: 2, limit: 4 },
      { agents: 4, limit: 4 },
      { agents: 8, limit: 4 },
      { agents: 8, limit: 8 },
    ]) {
      // Each scenario owns a fresh process so earlier scenarios cannot inflate its RSS.
      const child = Bun.spawn(
        [
          process.execPath,
          "--conditions=development",
          fileURLToPath(import.meta.url),
          String(waves),
          JSON.stringify({ ...load, cadence }),
        ],
        { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
      );

      const watchdog = setTimeout(() => child.kill(), waves * 20_000 + 30_000);
      let code;
      try {
        code = await child.exited;
      } finally {
        clearTimeout(watchdog);
        child.kill();
      }

      if (code !== 0) {
        process.exitCode = code || 1;
        break;
      }
    }

    if (process.exitCode) break;
  }
}

async function measure(scenario: Scenario) {
  const upstream = new McpServer({ name: "concurrency-baseline-upstream", version: "0.0.0" });
  let upstreamCalls = 0;
  upstream.registerTool(
    "search",
    {
      description: "Search documents",
      inputSchema: z.object({ query: z.literal("design") }),
    },
    async () => {
      upstreamCalls++;
      await Bun.sleep(150);

      return { content: [{ type: "text", text: JSON.stringify({ ids: ["guide", "design"] }) }] };
    },
  );
  upstream.registerTool(
    "fetch",
    {
      description: "Fetch documents",
      inputSchema: z.object({ id: z.enum(["guide", "design"]) }),
    },
    async ({ id }) => {
      upstreamCalls++;
      await Bun.sleep(300);

      return {
        content: [{ type: "text", text: JSON.stringify({ id, text: "x".repeat(65_536) }) }],
      };
    },
  );

  await using provider = await connect(upstream);
  const catalog = await createMcpCatalog(provider.client);

  const config = Configuration.parse({
    upstream: { command: "unused-in-memory" },
    sandbox: { maxConcurrentExecutions: scenario.limit },
  });

  await using gateway = await connect(createServer(catalog, config.sandbox));
  const samples: Sample[] = [];
  const workflows: Sample[] = [];

  async function workflow() {
    const started = performance.now();
    for (const [index, step] of steps.entries()) {
      if (index > 0) await Bun.sleep(100);

      const start = performance.now();

      const response = await gateway.client.callTool({
        name: "execute",
        arguments: { code: step.code },
      });

      const elapsedMs = performance.now() - start;
      const report = envelope.parse(response.structuredContent);
      if (!report.result.ok) {
        strictEqual(response.isError, true);
        strictEqual(report.result.error.maximum, scenario.limit);
        deepStrictEqual(report.calls, []);
        samples.push({ step: step.name, elapsedMs, status: "rejected" });
        workflows.push({
          step: step.name,
          elapsedMs: performance.now() - started,
          status: "rejected",
        });

        return;
      }

      strictEqual(response.isError, false);
      deepStrictEqual(report.result.value, step.expected);
      deepStrictEqual(
        report.calls.map((call) => call.name),
        step.calls,
      );
      samples.push({ step: step.name, elapsedMs, status: "completed" });
    }

    workflows.push({ step: "all", elapsedMs: performance.now() - started, status: "completed" });
  }

  // Validate and warm the complete path before measuring; leave GC automatic.
  await workflow();
  strictEqual(workflows[0]?.status, "completed");
  samples.length = 0;
  workflows.length = 0;
  upstreamCalls = 0;
  const rssBefore = process.memoryUsage.rss();
  let peakRss = rssBefore;

  const sample = () => {
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
  };

  const timer = setInterval(sample, 5);
  using cleanup = new DisposableStack();
  cleanup.defer(() => clearInterval(timer));
  const started = performance.now();

  for (let wave = 1; wave <= waves; wave++) {
    const results = await Promise.allSettled(
      Array.from({ length: scenario.agents }, async (_, index) => {
        if (scenario.cadence === "staggered") await Bun.sleep(index * 150);

        await workflow();
      }),
    );

    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }

    sample();
    console.log(
      JSON.stringify({ phase: "wave", ...scenario, wave, rss: process.memoryUsage.rss() }),
    );
  }

  const elapsedMs = performance.now() - started;
  const completed = workflows.filter((item) => item.status === "completed");
  const rejected = workflows.filter((item) => item.status === "rejected");
  strictEqual(workflows.length, waves * scenario.agents);
  strictEqual(
    upstreamCalls,
    samples.reduce((total, item) => {
      if (item.status !== "completed") return total;

      if (item.step === "search") return total + 1;

      if (item.step === "fetch") return total + 2;

      return total;
    }, 0),
  );
  const rssAfter = process.memoryUsage.rss();
  await Bun.sleep(1000);
  console.log(
    JSON.stringify({
      phase: "summary",
      ...scenario,
      waves,
      elapsedMs,
      upstreamCalls,
      workflows: {
        attempted: workflows.length,
        completed: completed.length,
        rejected: rejected.length,
        rejectionRate: rejected.length / workflows.length,
        completedPerSecond: (completed.length * 1000) / elapsedMs,
        completedMs: latency(completed),
      },
      requests: {
        attempted: samples.length,
        rejected: rejected.length,
        rejectionRate: rejected.length / samples.length,
        rejectedMs: latency(samples.filter((item) => item.status === "rejected")),
        completedMs: Object.fromEntries(
          steps.map((step) => [
            step.name,
            latency(
              samples.filter((item) => item.step === step.name && item.status === "completed"),
            ),
          ]),
        ),
        rejectionsByStep: Object.fromEntries(
          steps.map((step) => [
            step.name,
            rejected.filter((item) => item.step === step.name).length,
          ]),
        ),
      },
      rss: {
        before: rssBefore,
        sampledPeak: peakRss,
        after: rssAfter,
        idle: process.memoryUsage.rss(),
      },
    }),
  );
}

function latency(samples: Sample[]) {
  const sorted = samples.map((item) => item.elapsedMs).sort((a, b) => a - b);
  if (sorted.length === 0) return null;

  return {
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
  };
}

async function connect(server: McpServer) {
  const client = new Client({ name: "concurrency-baseline", version: "0.0.0" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  const cleanup = new AsyncDisposableStack();
  cleanup.defer(() => server.close());
  cleanup.defer(() => client.close());
  try {
    await server.connect(remote);
    await client.connect(local);
  } catch (cause) {
    await cleanup.disposeAsync();
    throw cause;
  }

  return { client, [Symbol.asyncDispose]: () => cleanup.disposeAsync() };
}
