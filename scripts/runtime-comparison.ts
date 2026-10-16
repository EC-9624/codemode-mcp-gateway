import { deepEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpus, release } from "node:os";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { type ExecutionReport } from "@cmg/codemode";

const args = parseArgs({
  options: {
    scenario: { type: "string" },
    runs: { type: "string" },
    batch: { type: "string" },
    concurrency: { type: "string" },
    footprint: { type: "boolean", default: false },
  },
});

const options = z
  .object({
    scenario: z.enum(["empty", "wasm", "scalar", "tool", "cpu", "microtasks", "mcp"]),
    runs: z.coerce.number().int().min(1).max(10000).default(1000),
    batch: z.coerce.number().int().min(1).max(1000).default(100),
    concurrency: z.coerce.number().int().min(1).max(8).default(1),
    footprint: z.boolean(),
  })
  .parse(args.values);

if (options.footprint && process.platform !== "darwin")
  throw new Error("--footprint requires macOS footprint.");

// Optional allocator diagnostics are Bun-only; ps supplies consistent cross-host RSS.
const allocator =
  process.versions.bun === undefined ? undefined : (await import("bun:jsc")).memoryUsage;

await using cleanup = new AsyncDisposableStack();
let workersStarted = 0;
let workerReplies = 0;
let workerExits = 0;
const operation = await workload();
let peakRss = process.memoryUsage.rss();

const sample = () => {
  peakRss = Math.max(peakRss, process.memoryUsage.rss());
};

const sampler = setInterval(sample, 5);
cleanup.defer(() => clearInterval(sampler));

console.log(
  JSON.stringify({
    phase: "environment",
    ...options,
    versions: process.versions,
    host: process.versions.bun === undefined ? "node" : "bun",
    execPath: process.execPath,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    cpu: cpus()[0]?.model,
    fastMemory: process.env.BUN_JSC_useWasmFastMemory ?? "default",
    warmup: 10,
    rssSampleIntervalMs: 5,
    idleMs: 1000,
    gc: "automatic",
    exports: "compiled",
    osRss: "ps -o rss= -p PID; KiB converted to bytes",
  }),
);
snapshot("before", 0);
for (let index = 0; index < 10; index++) await operation();

snapshot("warmup", 0);
const latencies: number[] = [];
const started = performance.now();
const cpu = process.cpuUsage();
for (let completed = 0; completed < options.runs;) {
  const end = Math.min(completed + options.batch, options.runs);
  const batchStarted = performance.now();
  const samples: number[] = [];
  while (completed < end) {
    const count = Math.min(options.concurrency, end - completed);
    await Promise.all(
      Array.from({ length: count }, async () => {
        const start = performance.now();
        await operation();
        const duration = performance.now() - start;
        samples.push(duration);
        latencies.push(duration);
      }),
    );
    completed += count;
  }

  snapshot("batch", completed, {
    elapsedMs: performance.now() - batchStarted,
    latencyMs: latency(samples),
  });
}

const elapsedMs = performance.now() - started;
const cpuUsed = process.cpuUsage(cpu);
snapshot("complete", options.runs, {
  elapsedMs,
  executionsPerSecond: (options.runs * 1000) / elapsedMs,
  latencyMs: latency(latencies),
  cpuMicroseconds: cpuUsed,
});
await setTimeout(1000);
snapshot("idle", options.runs);

function snapshot(phase: string, completed: number, metrics = {}) {
  sample();

  const osRssBytes =
    Number(
      execFileSync("/bin/ps", ["-o", "rss=", "-p", String(process.pid)], {
        encoding: "utf8",
      }).trim(),
    ) * 1024;

  if (!Number.isSafeInteger(osRssBytes) || osRssBytes <= 0)
    throw new Error("OS RSS probe returned an invalid value.");

  console.log(
    JSON.stringify({
      phase,
      completed,
      ...metrics,
      memory: process.memoryUsage(),
      osRssBytes,
      footprint: options.footprint ? physicalFootprint() : undefined,
      peakRss,
      allocator: allocator?.(),
      workersStarted,
      workerReplies,
      workerExits,
    }),
  );
}

function physicalFootprint() {
  const output = execFileSync(
    "/usr/bin/footprint",
    ["-p", String(process.pid), "--noCategories", "-f", "bytes"],
    { encoding: "utf8" },
  );

  const current = Number(output.match(/phys_footprint:\s*(\d+)\s+B/)?.[1]);
  const peak = Number(output.match(/phys_footprint_peak:\s*(\d+)\s+B/)?.[1]);
  if (
    !Number.isSafeInteger(current) ||
    current <= 0 ||
    !Number.isSafeInteger(peak) ||
    peak < current
  )
    throw new Error("OS footprint probe returned invalid values.");

  return { currentBytes: current, peakBytes: peak };
}

function latency(samples: number[]) {
  const values = samples.toSorted((a, b) => a - b);

  return {
    p50: values[Math.ceil(values.length * 0.5) - 1],
    p95: values[Math.ceil(values.length * 0.95) - 1],
    max: values.at(-1),
  };
}

async function workload(): Promise<() => Promise<void>> {
  if (options.scenario === "empty" || options.scenario === "wasm")
    return async () => {
      const worker = new Worker(new URL("./fixtures/runtime-worker.ts", import.meta.url), {
        workerData: options.scenario,
      });

      workersStarted++;
      const reply = Promise.withResolvers<unknown>();
      const exit = Promise.withResolvers<number>();
      const failed = Promise.withResolvers<never>();
      let stopped = false;
      worker.once("message", (value) => {
        workerReplies++;
        reply.resolve(value);
      });
      worker.on("error", (cause) => failed.reject(cause));
      worker.once("exit", (code) => {
        stopped = true;
        workerExits++;
        exit.resolve(code);
      });

      const watchdog = globalThis.setTimeout(
        () => failed.reject(new Error("Probe worker exceeded 10 seconds.")),
        10000,
      );

      try {
        const value = await Promise.race([
          Promise.all([reply.promise, exit.promise]),
          failed.promise,
        ]);

        deepEqual(value, [42, 0]);
      } finally {
        clearTimeout(watchdog);
        if (!stopped) await worker.terminate();

        await exit.promise;
        worker.removeAllListeners();
      }
    };

  const { CodeExecutor, ToolResult, createDiscoveryTools } = await import("@cmg/codemode");
  const text = options.scenario === "tool" ? "x".repeat(1024 * 1024) : "";

  const executor = new CodeExecutor({
    maxConcurrentExecutions: options.concurrency,
    timeoutMs: 5000,
    totalTimeoutMs: 10000,
    tools: options.scenario === "tool" ? { read: () => ToolResult.success({ text }) } : {},
  });

  if (options.scenario === "mcp") {
    const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client");
    const { McpServer } = await import("@modelcontextprotocol/server");
    const { createMcpCatalog, createCodemodeServer } = await import("@cmg/mcp");
    const upstream = new McpServer({ name: "runtime-benchmark", version: "0" });
    cleanup.defer(() => upstream.close());
    upstream.registerTool("read", { description: "Read documents" }, () => ({
      content: [],
      structuredContent: { text: "x".repeat(65536) },
    }));
    const client = new Client({ name: "runtime-provider", version: "0" });
    cleanup.defer(() => client.close());
    const [local, remote] = InMemoryTransport.createLinkedPair();
    await upstream.connect(remote);
    await client.connect(local);
    const catalog = await createMcpCatalog(client);
    const tools = { ...catalog.tools, ...createDiscoveryTools(catalog) };
    const reports = new Map<string, ExecutionReport>();
    let sequence = 0;

    const server = createCodemodeServer({
      execute: async (code, request) => {
        const report = await executor.execute(code, { ...request, tools });
        reports.set(code, report);

        return report;
      },
    });

    cleanup.defer(() => server.close());
    const agent = new Client({ name: "runtime-agent", version: "0" });
    cleanup.defer(() => agent.close());
    const [agentLocal, agentRemote] = InMemoryTransport.createLinkedPair();
    await server.connect(agentRemote);
    await agent.connect(agentLocal);

    return async () => {
      const code = `
        const found = await tools.searchTools({ query: "documents" });
        const name = found.tools[0].name;
        await tools.describeTool({ name });
        return (await tools[name]({})).structuredContent.text.length;
        // diagnostic request ${++sequence}
      `;

      const response = await agent.callTool({
        name: "execute",
        arguments: { code },
      });

      const report = reports.get(code);
      reports.delete(code);
      deepEqual(report, {
        result: { ok: true, value: 65536 },
        calls: [
          { callId: 1, name: "searchTools", status: "completed" },
          { callId: 2, name: "describeTool", status: "completed" },
          { callId: 3, name: "read", status: "completed" },
        ],
      });
      deepEqual(response, { content: [{ type: "text", text: "65536" }] });
    };
  }

  const scripts = {
    scalar: { code: "return 42;", value: 42, calls: [] },
    tool: {
      code: "return (await tools.read()).text.length;",
      value: 1048576,
      calls: [{ callId: 1, name: "read", status: "completed" }],
    },
    cpu: {
      code: "let total = 0; for (let i = 0; i < 500000; i++) total += i % 7; return total;",
      value: 1499994,
      calls: [],
    },
    microtasks: {
      code: "for (let i = 0; i < 1000; i++) await Promise.resolve(); return 42;",
      value: 42,
      calls: [],
    },
  };

  const script = scripts[options.scenario];

  return async () => {
    const report = await executor.execute(script.code);
    deepEqual(report, { result: { ok: true, value: script.value }, calls: script.calls });
  };
}
