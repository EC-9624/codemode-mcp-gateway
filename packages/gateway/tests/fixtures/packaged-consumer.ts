import { ok, deepEqual } from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { CodeExecutor, createDiscoveryTools } from "@codemode-mcp-gateway/codemode";
import { createMcpCatalog, createCodemodeServer } from "@codemode-mcp-gateway/mcp";
import { Configuration, Gateway } from "codemode-mcp-gateway";
import { dirname } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

// This fixture is copied into an unrelated directory and imports only installed public exports.
for (const name of [
  "@codemode-mcp-gateway/codemode",
  "@codemode-mcp-gateway/mcp",
  "codemode-mcp-gateway",
]) {
  const installed = fileURLToPath(import.meta.resolve(name));
  ok(installed.startsWith(fileURLToPath(new URL("./node_modules/", import.meta.url))));
  ok(installed.endsWith("/dist/index.js"));
}

await using cleanup = new AsyncDisposableStack();
const upstream = new McpServer({ name: "packed-upstream", version: "1" });
upstream.registerTool(
  "add",
  { inputSchema: z.object({ a: z.number(), b: z.number() }) },
  ({ a, b }) => ({
    content: [],
    structuredContent: { sum: a + b },
  }),
);
const upstreamClient = new Client({ name: "packed-catalog", version: "1" });
const [clientWire, upstreamWire] = InMemoryTransport.createLinkedPair();
cleanup.defer(() => upstream.close());
cleanup.defer(() => upstreamClient.close());
await upstream.connect(upstreamWire);
await upstreamClient.connect(clientWire);
const catalog = await createMcpCatalog(upstreamClient);

const executor = new CodeExecutor();
const tools = { ...catalog.tools, ...createDiscoveryTools(catalog) };

const server = createCodemodeServer({
  execute: (code, options) => executor.execute(code, { ...options, tools }),
});

const agent = new Client({ name: "packed-agent", version: "1" });
const [agentWire, serverWire] = InMemoryTransport.createLinkedPair();
cleanup.defer(() => server.close());
cleanup.defer(() => agent.close());
await server.connect(serverWire);
await agent.connect(agentWire);
deepEqual(
  (await agent.listTools()).tools.map((tool) => tool.name),
  ["execute"],
);

const sum = await agent.callTool({
  name: "execute",
  arguments: { code: "return (await tools.add({ a: 2, b: 3 })).structuredContent.sum;" },
});

deepEqual(sum, { content: [{ type: "text", text: "5" }] });

const binary = process.argv[2];
const config = process.argv[3];
if (binary === undefined || config === undefined)
  throw new Error("Expected packaged CLI and configuration paths.");

const cli = new Client({ name: "packed-cli", version: "1" });

const transport = new StdioClientTransport({
  command: binary,
  args: ["serve", "--transport", "stdio", "--config", config],
  stderr: "pipe",
});

const closed = Promise.withResolvers<void>();
transport.onclose = () => closed.resolve();
const connecting = cli.connect(transport, { timeout: 5_000 });
const spawned = transport.pid !== null;
cleanup.defer(async () => {
  if (spawned) await closed.promise;
});
cleanup.defer(() => transport.close());
cleanup.defer(() => cli.close());
await connecting;

const readySignal = AbortSignal.timeout(5000);
while (true) {
  readySignal.throwIfAborted();

  const ready = await cli.callTool(
    {
      name: "execute",
      arguments: {
        code: 'return (await tools.searchTools({ query: "add", server: "math" })).servers[0].state;',
      },
    },
    { signal: readySignal },
  );

  const state = ready.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");

  if (state === "connected") break;

  deepEqual(state, "connecting");
  await Bun.sleep(50);
}

const response = await cli.callTool({
  name: "execute",
  arguments: { code: 'return (await tools["math.add"]({ a: 20, b: 22 })).structuredContent.sum;' },
});

deepEqual(response, { content: [{ type: "text", text: "42" }] });

// Catalog revisions and worker startup must also work through compiled package exports.
await using named = new Gateway(
  Configuration.parse({
    mcp: {
      servers: {
        one: { type: "local", command: [process.execPath, "mcp-server.ts"], cwd: "../upstream" },
        two: { type: "local", command: [process.execPath, "mcp-server.ts"], cwd: "../upstream" },
      },
    },
  }),
  dirname(config),
);

await named.start();
const namedServer = named.createServer();
const namedClient = new Client({ name: "packed-named", version: "1" });
const [namedLocal, namedRemote] = InMemoryTransport.createLinkedPair();
cleanup.defer(() => namedClient.close());
await namedServer.connect(namedRemote);
await namedClient.connect(namedLocal);

const combined = await namedClient.callTool({
  name: "execute",
  arguments: {
    code: `return await Promise.all([
  tools["one.add"]({ a: 1, b: 2 }).then(r => r.structuredContent.sum),
  tools["two.add"]({ a: 3, b: 4 }).then(r => r.structuredContent.sum),
]);`,
  },
});

deepEqual(combined, { content: [{ type: "text", text: "[3,7]" }] });
