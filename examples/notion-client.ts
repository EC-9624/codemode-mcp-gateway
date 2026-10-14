import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const configuration = process.argv[2];
const query = process.argv[3];
const page = process.argv[4];
if (configuration === undefined || query === undefined || query.trim() === "") {
  console.error(
    "Usage: bun run example:notion <configuration.json> <search query> [page URL or id]",
  );
  process.exit(1);
}

const client = new Client({ name: "cmg-notion-smoke", version: "0.0.0" });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    "--conditions=development",
    fileURLToPath(new URL("../packages/gateway/src/cli.ts", import.meta.url)),
    resolve(configuration),
  ],
});

await using cleanup = new AsyncDisposableStack();
const closed = Promise.withResolvers<void>();
transport.onclose = () => closed.resolve();
const connecting = client.connect(transport, { timeout: 30_000 });
const spawned = transport.pid !== null;
cleanup.defer(async () => {
  if (spawned) await closed.promise;
});
cleanup.defer(() => transport.close());
cleanup.defer(() => client.close());
await connecting;

const codes = [
  'return (await tools.searchTools({ query: "notion search" })).map(tool => tool.name);',
  'return (await tools.describeTool({ name: "notion-search" })).name;',
  `const response = await tools["notion-search"]({ query: ${JSON.stringify(query)} });
   if (response.isError) throw new Error("Notion search failed.");
   return { contentBlocks: response.content.length };`,
];

if (page !== undefined) {
  codes.push(`const response = await tools["notion-fetch"]({ id: ${JSON.stringify(page)} });
    if (response.isError) throw new Error("Notion fetch failed.");
    return { contentBlocks: response.content.length };`);
}

for (const code of codes) {
  const response = await client.callTool({ name: "execute", arguments: { code } });
  // Print compact verification results, not page contents or retained upstream bodies.
  console.log(JSON.stringify(response.structuredContent));
  if (response.isError) {
    process.exitCode = 1;
    break;
  }
}
