import {
  Client,
  InMemoryTransport,
  type ClientOptions,
  type Tool,
} from "@modelcontextprotocol/client";
import { Server, type McpServer } from "@modelcontextprotocol/server";
import { type ToolCatalog } from "@cmg/codemode";

/** Own both ends, including partially completed setup. Each test owns its server handlers. */
export async function connectMcp(server: Server | McpServer, options?: ClientOptions) {
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => server.close());
  const client = new Client({ name: "cmg-test", version: "0.0.0" }, options);
  cleanup.defer(() => client.close());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport, { timeout: 1_000 });
  const owned = cleanup.move();

  return {
    client,
    serverTransport,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

/** A server with the tools capability. Given `tools`, it answers `tools/list` with that listing. */
export function toolServer(tools?: Tool[]) {
  const server = new Server(
    { name: "cmg-test", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  if (tools !== undefined) server.setRequestHandler("tools/list", () => ({ tools }));

  return server;
}

export function requireTool(catalog: ToolCatalog, name: string) {
  const tool = catalog.tools[name];
  if (tool === undefined) throw new Error(`Missing discovered tool ${JSON.stringify(name)}.`);

  return tool;
}
