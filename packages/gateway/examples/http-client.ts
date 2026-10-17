import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { responseText } from "./output.ts";
import { waitForServer } from "./readiness.ts";

const token = process.env.GW_HTTP_TOKEN;
if (token === undefined || token === "")
  throw new Error(
    "Supply the running gateway's token through GW_HTTP_TOKEN; never pass it as a command argument.",
  );

if (process.argv.length > 3)
  throw new Error("Usage: bun run example:http [http://127.0.0.1:4791/mcp]");

const url = new URL(process.argv[2] ?? "http://127.0.0.1:4791/mcp");
if (
  url.protocol !== "http:" ||
  url.hostname !== "127.0.0.1" ||
  url.username !== "" ||
  url.password !== "" ||
  url.hash !== ""
)
  throw new Error("This example sends credentials only to an explicit loopback HTTP gateway.");

const client = new Client({ name: "gateway-http-example", version: "0.0.0" });

const transport = new StreamableHTTPClientTransport(url, {
  requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: "error" },
});

await using cleanup = new AsyncDisposableStack();
cleanup.defer(() => client.close());
cleanup.defer(() => transport.terminateSession());
await client.connect(transport, { timeout: 5_000 });
await waitForServer(client, "math");

console.log((await client.listTools()).tools.map((tool) => tool.name));
for (const code of [
  'return await tools.searchTools({ query: "Add numbers", server: "math" });',
  'return await tools.describeTool({ name: "math.add" });',
  'const response = await tools["math.add"]({ a: 2, b: 3 }); if (response.isError) throw new Error("The upstream add tool failed."); return response.structuredContent.sum;',
]) {
  const response = await client.callTool({ name: "execute", arguments: { code } });
  if (response.isError) throw new Error(`Gateway execution failed: ${responseText(response)}`);

  console.log(responseText(response));
}
