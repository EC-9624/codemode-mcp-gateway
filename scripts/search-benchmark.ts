import { ok, strictEqual } from "node:assert";
import { cpus } from "node:os";
import {
  createDiscoveryTools,
  ToolCatalog,
  type ToolDefinition,
} from "@codemode-mcp-gateway/codemode";
import { searchCorpus } from "./fixtures/search-corpus.ts";

strictEqual(process.argv.length, 2, "Usage: bun run bench:search");

const warmups = 20;
const iterations = 100;

const scenarios = [
  { toolCount: 100, extraDescriptionRepeats: 0 },
  { toolCount: 1_000, extraDescriptionRepeats: 0 },
  { toolCount: 10_000, extraDescriptionRepeats: 0 },
  { toolCount: 1_000, extraDescriptionRepeats: 24 },
];

console.log(
  JSON.stringify(
    {
      environment: {
        bun: Bun.version,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model,
      },
      warmups,
      iterations,
      notes:
        "Synthetic metadata; real public catalog/discovery APIs. Sequential warm queries, no upstream/VM/MCP calls. Heap delta includes catalog/index only, after GC; not RSS or a memory limit. No latency gates.",
      results: scenarios.map(benchmark),
    },
    null,
    2,
  ),
);

function benchmark(scenario: (typeof scenarios)[number]) {
  const { toolCount, extraDescriptionRepeats } = scenario;

  const extraDescription =
    " Additional documentation about paging, filters, permissions, constraints, and returned data.".repeat(
      extraDescriptionRepeats,
    );

  const definitions: Record<string, ToolDefinition> = {};
  for (let index = 0; index < toolCount; index += 1) {
    const tool = searchCorpus[index % searchCorpus.length];
    ok(tool);
    const name = `mock${Math.floor(index / searchCorpus.length)}.${tool.name}`;
    definitions[name] = {
      // All tools match the broad query, exercising sorting and paging at full catalog size.
      description: `${tool.description} Synthetic records for partition ${Math.floor(index / searchCorpus.length)}.${extraDescription}`,
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
      execute: () => {
        throw new Error("Search benchmark must not invoke tools.");
      },
    };
  }

  Bun.gc(true);
  const heapBefore = process.memoryUsage().heapUsed;
  const buildStarted = performance.now();
  const catalog = ToolCatalog.create(definitions);
  const buildMs = performance.now() - buildStarted;
  const discovery = createDiscoveryTools(catalog);
  Bun.gc(true);
  const retainedHeapBytes = process.memoryUsage().heapUsed - heapBefore;

  strictEqual(catalog.search("mock0.billing.listInvoices")[0]?.name, "mock0.billing.listInvoices");
  strictEqual(catalog.search("records").length, toolCount);
  strictEqual(catalog.search("qzxv nonexistent").length, 0);

  const queries = [
    { name: "exact qualified name", query: "mock0.billing.listInvoices" },
    { name: "intent", query: "customer invoices" },
    { name: "plural aliases", query: "failed webhook deliveries" },
    { name: "all tools match", query: "records" },
    { name: "no matches", query: "qzxv nonexistent" },
  ].map(({ name, query }) => {
    const matches = catalog.search(query).length;

    return { name, query, matches, ...measure(() => catalog.search(query)) };
  });

  // Calling the host discovery callback still ranks all matches before returning five previews.
  const page = discovery.searchTools({ query: "records" });
  ok(page.ok);
  ok(typeof page.value === "object" && page.value !== null);
  ok("tools" in page.value && Array.isArray(page.value.tools));
  strictEqual(page.value.tools.length, 5);
  ok("total" in page.value);
  strictEqual(page.value.total, toolCount);
  ok("nextOffset" in page.value);
  strictEqual(page.value.nextOffset, 5);

  return {
    toolCount,
    descriptionProfile: extraDescriptionRepeats === 0 ? "short" : "long repeated documentation",
    averageDescriptionChars:
      Object.values(definitions).reduce((sum, tool) => sum + tool.description.length, 0) /
      toolCount,
    metadataBytes: Buffer.byteLength(JSON.stringify(definitions)),
    buildMs,
    retainedHeapBytes,
    queries,
    discoveryPage: {
      ...measure(() => discovery.searchTools({ query: "records" })),
      returnedTools: 5,
      total: toolCount,
      responseBytes: Buffer.byteLength(JSON.stringify(page.value)),
    },
  };
}

function measure(run: () => unknown) {
  for (let index = 0; index < warmups; index += 1) run();

  const samples = Array.from({ length: iterations }, () => {
    const started = performance.now();
    run();

    return performance.now() - started;
  }).sort((a, b) => a - b);

  const median = samples[Math.ceil(samples.length * 0.5) - 1];
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  ok(median !== undefined && p95 !== undefined);

  return { medianMs: median, p95Ms: p95 };
}
