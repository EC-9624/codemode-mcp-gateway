import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { CodeExecutor, ToolResult } from "@codemode-mcp-gateway/codemode";
import { createCodemodeServer } from "@codemode-mcp-gateway/mcp";

const executor = new CodeExecutor({
  tools: { answer: () => ToolResult.success(42) },
  timeoutMs: 1_000,
  totalTimeoutMs: 5_000,
});

const server = createCodemodeServer({
  execute: (code, options) => executor.execute(code, options),
});

const client = new Client({ name: "mcp-server-example", version: "0.0.0" });
const [local, remote] = InMemoryTransport.createLinkedPair();
await using cleanup = new AsyncDisposableStack();
cleanup.defer(() => client.close());
cleanup.defer(() => server.close());
await server.connect(remote);
await client.connect(local);

console.log(
  await client.callTool({ name: "execute", arguments: { code: "return await tools.answer();" } }),
);
