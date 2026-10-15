import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { waitForServer } from "./readiness.ts";

const client = new Client({ name: "cmg-agent-example", version: "0.0.0" });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    "--conditions=development",
    fileURLToPath(new URL("../packages/gateway/src/cli.ts", import.meta.url)),
    fileURLToPath(new URL("./cmg.json", import.meta.url)),
  ],
});

await using cleanup = new AsyncDisposableStack();
const closed = Promise.withResolvers<void>();
transport.onclose = () => closed.resolve();
const connecting = client.connect(transport, { timeout: 5_000 });
const spawned = transport.pid !== null;
cleanup.defer(async () => {
  if (spawned) await closed.promise;
});
cleanup.defer(() => transport.close());
cleanup.defer(() => client.close());
await connecting;
await waitForServer(client, "math");

console.log((await client.listTools()).tools.map((tool) => tool.name));
for (const code of [
  'return await tools.searchTools({ query: "Add numbers" });',
  'return await tools.describeTool({ name: "math.add" });',
  'return (await tools["math.add"]({ a: 2, b: 3 })).structuredContent.sum;',
]) {
  console.log((await client.callTool({ name: "execute", arguments: { code } })).structuredContent);
}
