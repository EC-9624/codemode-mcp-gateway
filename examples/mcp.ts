import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import { CodemodeSandbox } from "../src/codemode";
import { createMcpCatalog } from "../src/mcp";

const client = new Client({ name: "mcm-example", version: "0.0.0" });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./mcp-server.ts", import.meta.url))],
});

await using cleanup = new AsyncDisposableStack();
cleanup.defer(() => client.close());
await client.connect(transport, { timeout: 5_000 });
const catalog = await createMcpCatalog(client);
const sandbox = new CodemodeSandbox({ tools: catalog.tools, timeoutMs: 5_000 });

console.log(
  await sandbox.execute(
    `
      const sum = await tools.add({ a: 2, b: 3 });
      const failure = await tools.fail();
      const dataset = await tools.dataset({ count: 3000 });
      let validation;
      try { await tools.add({ a: "2", b: 3 }); }
      catch (error) { validation = error.message; }
      return {
        sum: sum.structuredContent.sum,
        failure: failure.isError,
        records: dataset.structuredContent.records.length,
        validation,
      };
    `,
  ),
);
