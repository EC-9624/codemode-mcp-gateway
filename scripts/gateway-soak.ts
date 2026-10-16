import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { stat } from "node:fs/promises";
import { cpus, release } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client, InMemoryTransport, SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { Configuration, Gateway } from "codemode-mcp-gateway";
import { z } from "zod";
import { createSoakUpstream } from "./fixtures/gateway-soak-upstream.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { smoke: { type: "boolean" }, minutes: { type: "string" }, child: { type: "boolean" } },
  strict: true,
});

const minutes = Number(values.minutes);
if (
  (values.smoke && values.minutes !== undefined) ||
  (!values.smoke && (!Number.isInteger(minutes) || minutes < 30 || minutes > 60))
) {
  throw new Error(
    "Usage: bun --conditions=development scripts/gateway-soak.ts --smoke | --minutes 30..60",
  );
}

const durationMs = values.smoke ? 0 : minutes * 60_000;
const watchdogMs = values.smoke ? 90_000 : durationMs + 120_000;

const statsSchema = z.object({
  documents: z.number().int(),
  failures: z.number().int(),
  waits: z.number().int(),
  aborted: z.number().int(),
  returned: z.number().int(),
  active: z.number().int(),
  pid: z.number().int(),
});

type Source = "stdio" | "http";

if (values.child) await measure();
else await supervise();

async function supervise() {
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=development",
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
      "--child",
    ],
    { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  );

  let forced = false;

  const watchdog = setTimeout(() => {
    forced = true;
    child.kill("SIGKILL");
  }, watchdogMs);

  try {
    const code = await child.exited;
    console.log(JSON.stringify({ phase: "process-exit", code, signal: child.signalCode, forced }));
    strictEqual(forced, false, "Soak exceeded watchdog; natural exit was not established");
    strictEqual(code, 0);
    strictEqual(child.signalCode, null);
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

async function measure() {
  const started = performance.now();

  const counts = {
    requests: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    shutdown: 0,
    cycles: 0,
    reconnects: 0,
    spills: 0,
  };

  let activeRequests = 0;
  let peakRequests = 0;
  let sampledPeakRss = 0;
  let phase = "setup";
  const connections = { stdio: 0, http: 0 };
  await using cleanup = new AsyncDisposableStack();
  const http = await httpUpstream();
  cleanup.defer(() => http.close());

  const gateway = new Gateway(
    Configuration.parse({
      mcp: {
        servers: {
          stdio: {
            type: "local",
            command: [
              process.execPath,
              fileURLToPath(new URL("./fixtures/gateway-soak-upstream.ts", import.meta.url)),
            ],
          },
          http: { type: "remote", url: http.url, oauth: false },
        },
      },
      sandbox: { timeoutMs: 20_000, totalTimeoutMs: 25_000, maxConcurrentExecutions: 4 },
    }),
    process.cwd(),
    {
      onStatus(status) {
        if (status.state === "connected" && (status.name === "stdio" || status.name === "http"))
          connections[status.name]++;

        console.log(JSON.stringify({ phase: "status", ...status }));
      },
    },
  );

  cleanup.defer(() => gateway.close());
  const client = new Client({ name: "gateway-soak", version: "0" });
  cleanup.defer(() => client.close());
  const server = gateway.createServer();
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote);
  await client.connect(local);
  await gateway.start();
  ok(gateway.status().every((status) => status.state === "connected"));

  function snapshot(event: string) {
    const memory = process.memoryUsage();
    sampledPeakRss = Math.max(sampledPeakRss, memory.rss);
    console.log(
      JSON.stringify({
        phase: event,
        workloadPhase: phase,
        elapsedMs: performance.now() - started,
        memoryScope: "diagnostic child: Gateway, workers, HTTP fixture, SDK; excludes stdio child",
        memory,
        sampledPeakRss,
        activeRequests,
        peakRequests,
        counts,
        connections,
        http: { ...http.counts(), active: http.active(), deletes: http.deletes() },
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
      gc: "automatic",
      durationMs,
      smoke: Boolean(values.smoke),
      sampleIntervalMs: 10_000,
      slotMs: 10_000,
      topology:
        "managed Gateway; in-memory agent edge; actual stdio child and loopback HTTP upstreams",
    }),
  );
  const timer = setInterval(() => snapshot("sample"), 10_000);
  cleanup.defer(() => clearInterval(timer));

  async function execute(code: string, signal?: AbortSignal) {
    counts.requests++;
    activeRequests++;
    peakRequests = Math.max(peakRequests, activeRequests);
    try {
      return await client.callTool(
        { name: "execute", arguments: { code } },
        signal === undefined ? undefined : { signal },
      );
    } finally {
      activeRequests--;
    }
  }

  async function success(code: string) {
    const response = await execute(code);
    strictEqual(response.isError, undefined);
    counts.completed++;

    return text(response);
  }

  async function stats(source: Source) {
    return statsSchema.parse(
      JSON.parse(await success(`return (await tools["${source}.stats"]({})).structuredContent;`)),
    );
  }

  async function document() {
    const result = await success(`return await Promise.all(["stdio", "http"].map(async s => {
      const d = (await tools[s + ".document"]({})).structuredContent.text;
      return { source: s, length: d.length, first: d[0], last: d[d.length - 1] };
    }));`);

    deepStrictEqual(
      JSON.parse(result),
      ["stdio", "http"].map((source) => ({ source, length: 65_536, first: "x", last: "x" })),
    );
  }

  async function active(source: Source, expected: number) {
    await until(
      async () => (await stats(source)).active === expected,
      `${source} active=${expected}`,
    );
  }

  const waitCode = (source: Source, id: string) =>
    `return (await tools["${source}.wait"]({ id: ${JSON.stringify(id)} })).structuredContent.id;`;

  const paths: string[] = [];
  async function spill() {
    const inline = await success(
      'return (await tools["stdio.document"]({})).structuredContent.text + (await tools["http.document"]({})).structuredContent.text;',
    );

    ok(Buffer.byteLength(inline) <= 40_000);
    const path = inline.match(/\[Full output: (.+)\]/)?.[1];
    ok(path, "Missing native-readable output path");
    strictEqual(await Bun.file(path).text(), "x".repeat(131_072));
    strictEqual((await stat(path)).mode & 0o777, 0o600);
    strictEqual((await stat(dirname(path))).mode & 0o777, 0o700);
    paths.push(path);
    counts.spills++;
  }

  phase = "warmup";
  console.log(JSON.stringify({ phase: "stdio-process", pid: (await stats("stdio")).pid }));

  const discovery = z
    .array(z.string())
    .parse(
      JSON.parse(
        await success(
          'return (await tools.searchTools({ query: "document" })).tools.map(t => t.name).sort();',
        ),
      ),
    );

  deepStrictEqual(discovery, ["http.document", "stdio.document"]);
  await document();
  await spill();
  snapshot("warmup");
  phase = "http-idle-check";
  const getsBeforeIdle = http.gets();

  const heldAcrossIdle = success(waitCode("http", "idle-check")).then(
    (value) => ({ ok: true, value }) as const,
    (cause: unknown) => ({ ok: false, cause }) as const,
  );

  await active("http", 1);
  // Time is the behavior: cross Bun's default 10s idle limit and the SDK's 15s
  // SSE heartbeat without reconnecting or losing the held JSON POST.
  await Bun.sleep(16_000);
  await success('await tools["http.release"]({ id: "idle-check" }); return "released";');
  const idleResult = await heldAcrossIdle;
  if (!idleResult.ok) throw idleResult.cause;

  strictEqual(idleResult.value, "idle-check");
  strictEqual(http.gets(), getsBeforeIdle, "Idle SSE unexpectedly reconnected");
  snapshot("http-idle-passed");
  const trafficStarted = performance.now();
  do {
    const cycle = counts.cycles;
    phase = `cycle-${cycle + 1}`;
    await document();

    // Explicitly hold two separate executions before releasing either: overlap is not inferred from timing.
    const held = ["stdio", "http"].map((source) => {
      const parsed = z.enum(["stdio", "http"]).parse(source);
      const id = `overlap-${cycle}`;

      return { source: parsed, id, done: success(waitCode(parsed, id)) };
    });

    await Promise.all(held.map((item) => active(item.source, 1)));
    for (const item of held) {
      await success(
        `await tools["${item.source}.release"]({ id: ${JSON.stringify(item.id)} }); return "released";`,
      );
    }

    deepStrictEqual(
      await Promise.all(held.map((item) => item.done)),
      held.map((item) => item.id),
    );

    const failureBefore = (await stats("http")).failures;
    strictEqual(
      await success(
        'const r = await tools["http.failure"]({}); return { failed: r.isError, text: r.content[0].text };',
      ),
      JSON.stringify({ failed: true, text: "Synthetic public failure" }),
    );
    strictEqual((await stats("http")).failures, failureBefore + 1);

    if (cycle % 4 < 2) {
      const source = cycle % 4 === 0 ? "stdio" : "http";
      const before = await stats(source);
      const controller = new AbortController();
      const reason = new Error("Controlled soak cancellation");

      const pending = execute(waitCode(source, `cancel-${cycle}`), controller.signal).then(
        () => {
          throw new Error("Cancelled execution unexpectedly fulfilled");
        },
        (cause: unknown) => {
          ok(cause instanceof SdkError);
          strictEqual(cause.code, SdkErrorCode.RequestTimeout);
          strictEqual(cause.message, String(reason));
        },
      );

      await active(source, 1);
      controller.abort(reason);
      await pending;
      await until(async () => {
        const after = await stats(source);

        return (
          after.active === 0 &&
          after.aborted === before.aborted + 1 &&
          after.returned === before.returned + 1
        );
      }, "cooperative upstream cancellation");
      counts.cancelled++;
    } else if (cycle % 4 === 2) {
      const old = await stats("stdio");
      const connected = connections.stdio;
      const pending = execute(waitCode("stdio", `disconnect-${cycle}`));
      await active("stdio", 1);
      process.kill(old.pid, "SIGTERM");
      strictEqual((await pending).isError, true);
      counts.failed++;
      await until(() => !alive(old.pid), "retired stdio child exit");
      await until(() => connections.stdio === connected + 1, "automatic stdio reconnect");
      const replacement = (await stats("stdio")).pid;
      ok(replacement !== old.pid);
      console.log(
        JSON.stringify({ phase: "stdio-process", pid: replacement, retiredPid: old.pid }),
      );
      counts.reconnects++;
    } else {
      const connected = connections.http;
      await http.expire();
      const failed = await execute('return await tools["http.document"]({});');
      strictEqual(failed.isError, true);
      counts.failed++;
      await until(() => connections.http === connected + 1, "automatic HTTP session reconnect");
      counts.reconnects++;
    }

    await document();
    strictEqual((await stats("stdio")).active, 0);
    strictEqual((await stats("http")).active, 0);
    strictEqual(activeRequests, 0);
    counts.cycles++;
    snapshot("cycle-complete");
    if (!values.smoke)
      await Bun.sleep(Math.max(0, trafficStarted + counts.cycles * 10_000 - performance.now()));
  } while (values.smoke ? counts.cycles < 4 : performance.now() - trafficStarted < durationMs);

  await spill();
  phase = "pre-shutdown-idle";
  snapshot("idle-start");
  await Bun.sleep(values.smoke ? 50 : 10_000);
  snapshot("idle-end");
  for (const path of paths) {
    strictEqual(await Bun.file(path).text(), "x".repeat(131_072));
  }

  phase = "shutdown";
  const pid = (await stats("stdio")).pid;
  const abortedBeforeShutdown = http.counts().aborted;
  const returnedBeforeShutdown = http.counts().returned;

  const pending = execute(waitCode("http", "shutdown")).then(
    () => {
      throw new Error("Shutdown request unexpectedly fulfilled");
    },
    (cause: unknown) => {
      ok(cause instanceof SdkError);
      strictEqual(cause.code, SdkErrorCode.ConnectionClosed);
    },
  );

  await active("http", 1);
  const shutdownStarted = performance.now();
  await gateway.close();
  const shutdownMs = performance.now() - shutdownStarted;
  await pending;
  counts.shutdown++;
  await until(() => !alive(pid), "owned stdio child exit after Gateway.close");
  await until(() => http.active() === 0, "HTTP handler return after shutdown");
  strictEqual(http.counts().aborted, abortedBeforeShutdown + 1);
  strictEqual(http.counts().returned, returnedBeforeShutdown + 1);
  ok(http.deletes() >= 1, "No HTTP session DELETE observed");
  for (const path of paths) {
    strictEqual(await Bun.file(path).exists(), false);

    const exists = await stat(dirname(path)).then(
      () => true,
      (cause: unknown) => {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;

        throw cause;
      },
    );

    strictEqual(exists, false);
  }

  await client.close();
  await http.close();
  strictEqual(activeRequests, 0);
  strictEqual(
    counts.requests,
    counts.completed + counts.failed + counts.cancelled + counts.shutdown,
  );
  strictEqual(counts.spills, 2);
  phase = "post-shutdown-idle";
  await Bun.sleep(values.smoke ? 50 : 10_000);
  snapshot("summary");
  console.log(JSON.stringify({ phase: "shutdown-timing", shutdownMs }));
}

function text(response: Awaited<ReturnType<Client["callTool"]>>) {
  return z
    .array(z.object({ type: z.literal("text"), text: z.string() }))
    .parse(response.content)
    .map((item) => item.text)
    .join("\n");
}

async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = performance.now() + 25_000;
  while (!(await check())) {
    ok(performance.now() < deadline, `Timed out waiting for ${label}`);
    await Bun.sleep(25);
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);

    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") return false;

    throw cause;
  }
}

async function httpUpstream() {
  async function session() {
    const upstream = createSoakUpstream();

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
    });

    await upstream.server.connect(transport);

    return { ...upstream, transport };
  }

  let current = await session();
  let expired = false;
  let deletions = 0;
  let gets = 0;
  let closed = false;

  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // The SDK sends SSE heartbeats every 15s and executions may wait for 25s.
    // Bun's default 10s idle timer otherwise interferes with the intended faults.
    idleTimeout: 30,
    async fetch(request) {
      if (request.method === "DELETE") deletions++;

      if (request.method === "GET") gets++;

      if (expired) {
        if (request.headers.has("mcp-session-id"))
          return new Response("Expired synthetic session", { status: 404 });

        current = await session();
        expired = false;
      }

      return current.transport.handleRequest(request);
    },
  });

  return {
    url: new URL("/mcp", listener.url).toString(),
    counts: () => current.counts,
    active: () => current.active(),
    deletes: () => deletions,
    gets: () => gets,
    async expire() {
      strictEqual(current.active(), 0);
      expired = true;
      await current.server.close();
    },
    async close() {
      if (closed) return;

      closed = true;
      await current.server.close();
      await listener.stop(true);
    },
  };
}
