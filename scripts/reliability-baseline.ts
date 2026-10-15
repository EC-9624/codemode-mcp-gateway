import { deepStrictEqual, strictEqual, ok } from "node:assert";
import { cpus, release } from "node:os";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport, SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpCatalog, createCodemodeServer } from "@cmg/mcp";
import { CodeExecutor, createDiscoveryTools } from "@cmg/codemode";
import { z } from "zod";
import { observeWorkers } from "./reliability-workers.ts";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--smoke" && arg !== "--child")) {
  throw new Error("Usage: bun run baseline:reliability [--smoke]");
}

const smoke = args.includes("--smoke");
const cycles = smoke ? 6 : 18;
const intervalMs = smoke ? 0 : 30_000;
const idleMs = smoke ? 250 : 30_000;

async function main() {
  if (args.includes("--child")) {
    await measure();
  } else {
    const child = Bun.spawn(
      [
        process.execPath,
        "--conditions=development",
        fileURLToPath(import.meta.url),
        ...args,
        "--child",
      ],
      { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
    );

    let forced = false;

    const watchdog = setTimeout(
      () => {
        forced = true;
        child.kill("SIGKILL");
      },
      smoke ? 60_000 : 660_000,
    );

    const started = performance.now();
    try {
      const code = await child.exited;
      console.log(
        JSON.stringify({
          phase: "process-exit",
          code,
          signal: child.signalCode,
          forced,
          elapsedMs: performance.now() - started,
        }),
      );
      strictEqual(forced, false, "Reliability diagnostic exceeded its watchdog");
      strictEqual(code, 0);
      strictEqual(child.signalCode, null);
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }
}

const reportSchema = z.object({
  result: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value: z.unknown() }),
    z.object({
      ok: z.literal(false),
      error: z.object({
        kind: z.string(),
        message: z.string(),
        resource: z.string().optional(),
        maximum: z.number().optional(),
      }),
    }),
  ]),
  calls: z.array(
    z.union([
      z.strictObject({ callId: z.number(), name: z.string(), status: z.literal("completed") }),
      z.strictObject({
        callId: z.number(),
        name: z.string(),
        status: z.literal("interrupted"),
        reason: z.string(),
      }),
    ]),
  ),
});

type Wait = ReturnType<typeof waitGate>;

function waitGate(cooperative: boolean) {
  return {
    cooperative,
    started: Promise.withResolvers<void>(),
    aborted: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
    returned: Promise.withResolvers<void>(),
  };
}

async function measure() {
  const started = performance.now();

  const counts = {
    attempted: 0,
    completed: 0,
    cancelled: 0,
    failed: 0,
    rejected: 0,
    shutdownDisconnected: 0,
    unexpected: 0,
    reportedCalls: 0,
    interruptedCalls: 0,
    peakRequests: 0,
  };

  const upstreamCounts = {
    search: 0,
    fetch: 0,
    wait: 0,
    failure: 0,
    aborted: 0,
    lateReturns: 0,
    active: 0,
    peakActive: 0,
    connections: 0,
  };

  const waits = new Map<string, Wait>();
  let activeRequests = 0;
  let phase = "setup";
  let peakRss = process.memoryUsage.rss();
  using workers = observeWorkers();
  await using cleanup = new AsyncDisposableStack();
  const provider = new Client({ name: "reliability-provider", version: "0" });
  cleanup.defer(() => provider.close());
  let upstream: McpServer | undefined;

  async function attach() {
    const server = new McpServer({ name: "reliability-upstream", version: "0" });
    upstream = server;
    cleanup.defer(() => server.close());
    server.registerTool(
      "search",
      { description: "Search documents", inputSchema: z.object({ query: z.literal("design") }) },
      async () => {
        upstreamCounts.search++;
        await Bun.sleep(120);

        return { content: [], structuredContent: { ids: ["guide", "design"] } };
      },
    );
    server.registerTool(
      "fetch",
      {
        description: "Fetch documents",
        inputSchema: z.object({ id: z.enum(["guide", "design"]) }),
      },
      async ({ id }) => {
        upstreamCounts.fetch++;
        await Bun.sleep(180);

        return { content: [], structuredContent: { id, text: "x".repeat(65_536) } };
      },
    );
    server.registerTool("failure", { description: "Return a recognized temporary failure" }, () => {
      upstreamCounts.failure++;

      return { isError: true, content: [{ type: "text", text: "Temporarily unavailable" }] };
    });
    server.registerTool(
      "wait",
      { inputSchema: z.object({ id: z.string() }) },
      async ({ id }, { mcpReq }) => {
        const gate = waits.get(id);
        if (gate === undefined) throw new Error(`Unknown diagnostic gate ${id}`);

        upstreamCounts.wait++;
        upstreamCounts.active++;
        upstreamCounts.peakActive = Math.max(upstreamCounts.peakActive, upstreamCounts.active);

        const abort = () => {
          upstreamCounts.aborted++;
          gate.aborted.resolve();
          if (gate.cooperative) gate.release.resolve();
        };

        mcpReq.signal.addEventListener("abort", abort, { once: true });
        if (mcpReq.signal.aborted) abort();

        gate.started.resolve();
        try {
          await gate.release.promise;
          if (mcpReq.signal.aborted && !gate.cooperative) upstreamCounts.lateReturns++;

          return { content: [], structuredContent: { id } };
        } finally {
          mcpReq.signal.removeEventListener("abort", abort);
          upstreamCounts.active--;
          gate.returned.resolve();
        }
      },
    );
    const [local, remote] = InMemoryTransport.createLinkedPair();
    await server.connect(remote);
    await provider.connect(local);
    upstreamCounts.connections++;
  }

  cleanup.defer(() => {
    for (const gate of waits.values()) gate.release.resolve();
  });
  await attach();
  const catalog = await createMcpCatalog(provider);

  const executor = new CodeExecutor({
    tools: { ...catalog.tools, ...createDiscoveryTools(catalog) },
    timeoutMs: 2000,
    totalTimeoutMs: 4000,
  });

  const server = createCodemodeServer({
    execute: (code, options) => executor.execute(code, options),
  });

  const agent = new Client({ name: "reliability-agent", version: "0" });
  cleanup.defer(() => agent.close());
  cleanup.defer(() => server.close());
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote);
  await agent.connect(local);

  function snapshot(event: string) {
    const rss = process.memoryUsage.rss();
    peakRss = Math.max(peakRss, rss);
    console.log(
      JSON.stringify({
        phase: event,
        workloadPhase: phase,
        elapsedMs: performance.now() - started,
        rss,
        peakRss,
        activeRequests,
        counts,
        upstream: upstreamCounts,
        workers: { ...workers.counts, active: workers.active },
      }),
    );
  }

  console.log(
    JSON.stringify({
      phase: "environment",
      startedAt: new Date().toISOString(),
      pid: process.pid,
      bun: Bun.version,
      revision: Bun.revision,
      platform: process.platform,
      arch: process.arch,
      osRelease: release(),
      cpu: cpus()[0]?.model,
      smoke,
      cycles,
      intervalMs,
      idleMs,
      rssSampleIntervalMs: 1000,
      gc: "automatic",
      capacity: 4,
      timeoutMs: 2000,
      totalTimeoutMs: 4000,
      documentCharacters: 65_536,
      topology:
        "one reusable MCP adapter and executor; in-memory MCP on both sides; explicit upstream reconnect using the same Client",
    }),
  );
  snapshot("before");
  const timer = setInterval(() => snapshot("sample"), 1000);
  cleanup.defer(() => clearInterval(timer));

  async function request(
    label: string,
    code: string,
    expected: unknown,
    names: string[],
    failure?: "script" | "timeout" | "limit",
  ) {
    counts.attempted++;
    activeRequests++;
    counts.peakRequests = Math.max(counts.peakRequests, activeRequests);
    const start = performance.now();
    try {
      const response = await agent.callTool({ name: "execute", arguments: { code } });
      const report = reportSchema.parse(response.structuredContent);
      deepStrictEqual(
        report.calls.map((call) => call.name),
        names,
      );
      counts.reportedCalls += report.calls.length;
      counts.interruptedCalls += report.calls.filter(
        (call) => call.status === "interrupted",
      ).length;
      deepStrictEqual(
        report.calls.map((call) => call.callId),
        names.map((_, index) => index + 1),
      );
      strictEqual(response.isError, failure !== undefined);
      if (failure === undefined) {
        deepStrictEqual(report.result, { ok: true, value: expected });
        ok(report.calls.every((call) => call.status === "completed"));
        counts.completed++;
      } else {
        ok(!report.result.ok);
        strictEqual(report.result.error.kind, failure);
        if (failure === "limit") {
          strictEqual(report.result.error.resource, "executions");
          strictEqual(report.result.error.maximum, 4);
          counts.rejected++;
        } else {
          if (failure === "script") strictEqual(report.result.error.message, "Host tool failed.");

          if (failure === "timeout")
            deepStrictEqual(report.calls, [
              { callId: 1, name: "wait", status: "interrupted", reason: "timeout" },
            ]);

          counts.failed++;
        }
      }

      console.log(
        JSON.stringify({
          phase: "request",
          label,
          elapsedMs: performance.now() - start,
          outcome: failure ?? "completed",
          calls: report.calls.length,
        }),
      );
    } catch (cause) {
      counts.unexpected++;
      throw cause;
    } finally {
      activeRequests--;
    }
  }

  const dataCode = `const found = (await tools.search({ query: "design" })).structuredContent;
    return await Promise.all(found.ids.map(async id => {
      const page = (await tools.fetch({ id })).structuredContent;
      return { id: page.id, characters: page.text.length, first: page.text[0], last: page.text[page.text.length - 1] };
    }));`;

  const expectedData = [
    { id: "guide", characters: 65_536, first: "x", last: "x" },
    { id: "design", characters: 65_536, first: "x", last: "x" },
  ];

  const data = (label: string) =>
    request(label, dataCode, expectedData, ["search", "fetch", "fetch"]);

  const discover = () =>
    request(
      "discovery",
      'return (await tools.searchTools({ query: "documents" })).tools.map(t => t.name).sort();',
      ["fetch", "search"],
      ["searchTools"],
    );

  const waitCode = (id: string) =>
    `return (await tools.wait({ id: ${JSON.stringify(id)} })).structuredContent.id;`;

  async function cancelled(id: string, cooperative: boolean) {
    const gate = waitGate(cooperative);
    waits.set(id, gate);
    const controller = new AbortController();
    counts.attempted++;
    activeRequests++;
    const reason = new Error("Diagnostic caller cancellation");

    const outcome = agent
      .callTool(
        { name: "execute", arguments: { code: waitCode(id) } },
        { signal: controller.signal },
      )
      .then(
        () => {
          throw new Error("Cancelled MCP request unexpectedly fulfilled");
        },
        (cause: unknown) => {
          ok(cause instanceof SdkError);
          strictEqual(cause.code, SdkErrorCode.RequestTimeout);
          strictEqual(cause.message, String(reason));
        },
      );

    await gate.started.promise;
    controller.abort(reason);
    await outcome;
    await gate.aborted.promise;
    await workers.drained();
    counts.cancelled++;
    activeRequests--;
    if (!cooperative) strictEqual(upstreamCounts.active, 1);

    // Prove recovery while the uncooperative callback still has not returned.
    await data("after-cancel");
    gate.release.resolve();
    await gate.returned.promise;
    await provider.ping();
    waits.delete(id);
  }

  phase = "warmup";
  await discover();
  await request(
    "describe",
    'return (await tools.describeTool({ name: "fetch" })).inputSchema.type;',
    "object",
    ["describeTool"],
  );
  await data("warmup");
  await workers.drained();
  snapshot("warmup");
  const trafficStarted = performance.now();

  for (let cycle = 0; cycle < cycles; cycle++) {
    phase = `cycle-${cycle + 1}`;
    await data("ordinary");
    await Bun.sleep(200);

    const overlap = await Promise.allSettled([
      data("overlap-a"),
      data("overlap-b"),
      data("overlap-c"),
    ]);

    for (const result of overlap) {
      if (result.status === "rejected") throw result.reason;
    }

    switch (cycle % 6) {
      case 0:
        await cancelled(`cooperative-${cycle}`, true);
        break;
      case 1:
        await cancelled(`late-${cycle}`, false);
        break;
      case 2:
        await request(
          "recognized-upstream-failure",
          "const r = await tools.failure(); return { failed: r.isError, message: r.content[0].text };",
          { failed: true, message: "Temporarily unavailable" },
          ["failure"],
        );
        await data("after-public-failure");
        break;
      case 3: {
        const id = `disconnect-${cycle}`;
        const gate = waitGate(false);
        waits.set(id, gate);

        const pending = request(
          "disconnect-in-flight",
          waitCode(id),
          undefined,
          ["wait"],
          "script",
        );

        await gate.started.promise;
        await upstream?.close();
        await pending;
        await request(
          "while-disconnected",
          'return await tools.search({ query: "design" });',
          undefined,
          ["search"],
          "script",
        );
        await discover();
        gate.release.resolve();
        await gate.returned.promise;
        waits.delete(id);
        await attach();
        await data("after-explicit-reconnect");
        break;
      }

      case 4: {
        const held = Array.from({ length: 4 }, (_, index) => {
          const id = `capacity-${cycle}-${index}`;
          const gate = waitGate(false);
          waits.set(id, gate);

          return { id, gate, completion: request("held-capacity", waitCode(id), id, ["wait"]) };
        });

        await Promise.all(held.map(({ gate }) => gate.started.promise));
        const observed = workers.counts.observed;
        await request("capacity-rejected", "return 42;", undefined, [], "limit");
        strictEqual(workers.counts.observed, observed);
        for (const { gate } of held) gate.release.resolve();

        await Promise.all(held.map(({ completion }) => completion));
        for (const { id } of held) waits.delete(id);

        await data("after-capacity");
        break;
      }

      case 5: {
        const id = `timeout-${cycle}`;
        const gate = waitGate(false);
        waits.set(id, gate);
        await request("deadline", waitCode(id), undefined, ["wait"], "timeout");
        await gate.aborted.promise;
        await data("after-deadline");
        gate.release.resolve();
        await gate.returned.promise;
        waits.delete(id);
        break;
      }
    }

    await workers.drained();
    strictEqual(activeRequests, 0);
    strictEqual(upstreamCounts.active, 0);
    strictEqual(waits.size, 0);
    snapshot("cycle-complete");
    phase = "between-requests-idle";
    await Bun.sleep(Math.max(0, trafficStarted + (cycle + 1) * intervalMs - performance.now()));
  }

  phase = "pre-shutdown-idle";
  snapshot("idle-start");
  await Bun.sleep(idleMs);
  await workers.drained();
  snapshot("idle-end");

  phase = "shutdown-active-request";
  const gate = waitGate(false);
  waits.set("shutdown", gate);
  counts.attempted++;
  activeRequests++;

  const shutdownRequest = agent
    .callTool({ name: "execute", arguments: { code: waitCode("shutdown") } })
    .then(
      () => {
        throw new Error("Shutdown request unexpectedly fulfilled");
      },
      (cause: unknown) => {
        ok(cause instanceof SdkError);
        strictEqual(cause.code, SdkErrorCode.ConnectionClosed);
      },
    );

  await gate.started.promise;
  const shutdownStarted = performance.now();
  await server.close();
  strictEqual(workers.active, 0, "Gateway close returned before worker exit");
  await shutdownRequest;
  await gate.aborted.promise;
  await workers.drained();
  const shutdownMs = performance.now() - shutdownStarted;
  strictEqual(upstreamCounts.active, 1);
  counts.shutdownDisconnected++;
  activeRequests--;
  gate.release.resolve();
  await gate.returned.promise;
  waits.delete("shutdown");
  await agent.close();
  await provider.close();
  await upstream?.close();
  phase = "post-shutdown-idle";
  snapshot("shutdown");
  await Bun.sleep(idleMs);
  await workers.drained();
  strictEqual(upstreamCounts.active, 0);
  strictEqual(counts.unexpected, 0);
  strictEqual(
    counts.attempted,
    counts.completed +
      counts.cancelled +
      counts.failed +
      counts.rejected +
      counts.shutdownDisconnected,
  );
  strictEqual(workers.counts.observed, counts.attempted - counts.rejected);
  strictEqual(upstreamCounts.connections, cycles / 6 + 1);
  deepStrictEqual(
    {
      completed: counts.completed,
      cancelled: counts.cancelled,
      failed: counts.failed,
      rejected: counts.rejected,
      shutdownDisconnected: counts.shutdownDisconnected,
    },
    smoke
      ? { completed: 39, cancelled: 2, failed: 3, rejected: 1, shutdownDisconnected: 1 }
      : { completed: 111, cancelled: 6, failed: 9, rejected: 3, shutdownDisconnected: 1 },
  );
  deepStrictEqual(
    {
      search: upstreamCounts.search,
      fetch: upstreamCounts.fetch,
      wait: upstreamCounts.wait,
      failure: upstreamCounts.failure,
    },
    smoke
      ? { search: 31, fetch: 62, wait: 9, failure: 1 }
      : { search: 91, fetch: 182, wait: 25, failure: 3 },
  );
  snapshot("summary");
  console.log(
    JSON.stringify({
      phase: "shutdown-timing",
      shutdownMs,
      elapsedMs: performance.now() - started,
    }),
  );
}

await main();
