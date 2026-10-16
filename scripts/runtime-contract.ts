import { deepEqual, equal, ok } from "node:assert/strict";
import { CodeExecutor, ToolResult, type ExecutionReport } from "@cmg/codemode";
import { createMcpCatalog, createCodemodeServer } from "@cmg/mcp";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

// Run against compiled public exports under either host, never repository internals.
const executor = new CodeExecutor({ timeoutMs: 1000, totalTimeoutMs: 5000 });
deepEqual(
  await executor.execute("let i = 0; while (i++ < 1000) await Promise.resolve(); return 42;"),
  {
    result: { ok: true, value: 42 },
    calls: [],
  },
);
deepEqual(
  (await executor.execute("while (true) {}", { signal: AbortSignal.timeout(100) })).result,
  {
    ok: false,
    error: { kind: "cancelled", message: "Execution cancelled." },
  },
);

const timeout = await new CodeExecutor({ timeoutMs: 50, totalTimeoutMs: 5000 }).execute(
  "while (true) {}",
);

deepEqual(timeout.result, {
  ok: false,
  error: { kind: "timeout", message: "Execution exceeded the 50 ms limit." },
});
deepEqual(await executor.execute('throw "guest";'), {
  result: { ok: false, error: { kind: "script", message: "guest" } },
  calls: [],
});
deepEqual((await executor.execute("return typeof process;")).result, {
  ok: true,
  value: "undefined",
});

const started = Promise.withResolvers<void>();
const release = Promise.withResolvers<ToolResult>();
const controller = new AbortController();

const held = new CodeExecutor({
  maxConcurrentExecutions: 1,
  totalTimeoutMs: 5000,
  tools: {
    wait: () => {
      started.resolve();

      return release.promise;
    },
  },
});

try {
  const pending = held.execute("return await tools.wait();", { signal: controller.signal });
  await started.promise;
  const rejected = await held.execute("return 1;");
  ok(!rejected.result.ok);
  equal(rejected.result.error.kind, "limit");
  controller.abort();
  deepEqual((await pending).calls, [
    { callId: 1, name: "wait", status: "interrupted", reason: "cancelled" },
  ]);
} finally {
  release.resolve(ToolResult.success());
}

deepEqual(await held.execute("return 42;"), { result: { ok: true, value: 42 }, calls: [] });

await using cleanup = new AsyncDisposableStack();
const upstream = new McpServer({ name: "runtime-contract", version: "0" });
cleanup.defer(() => upstream.close());
upstream.registerTool(
  "add",
  { inputSchema: z.object({ a: z.number(), b: z.number() }) },
  ({ a, b }) => ({ content: [], structuredContent: { sum: a + b } }),
);
const client = new Client({ name: "runtime-contract", version: "0" });
cleanup.defer(() => client.close());
const [local, remote] = InMemoryTransport.createLinkedPair();
await upstream.connect(remote);
await client.connect(local);
const catalog = await createMcpCatalog(client);

const reports: ExecutionReport[] = [];

const server = createCodemodeServer({
  execute: async (code, options) => {
    const report = await executor.execute(code, { ...options, tools: catalog.tools });
    reports.push(report);

    return report;
  },
});

cleanup.defer(() => server.close());
const agent = new Client({ name: "runtime-contract-agent", version: "0" });
cleanup.defer(() => agent.close());
const [agentLocal, agentRemote] = InMemoryTransport.createLinkedPair();
await server.connect(agentRemote);
await agent.connect(agentLocal);

const response = await agent.callTool({
  name: "execute",
  arguments: { code: "return (await tools.add({ a: 20, b: 22 })).structuredContent.sum;" },
});

deepEqual(response, { content: [{ type: "text", text: "42" }] });
deepEqual(reports, [
  {
    result: { ok: true, value: 42 },
    calls: [{ callId: 1, name: "add", status: "completed" }],
  },
]);
console.log(JSON.stringify({ phase: "contract", versions: process.versions, ok: true }));
