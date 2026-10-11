import { Client, InMemoryTransport, type ClientOptions } from "@modelcontextprotocol/client";
import { type McpServer, type Server } from "@modelcontextprotocol/server";

/** Own both ends, including partially completed setup. Each test owns its server handlers. */
export async function connectMcp(server: Server | McpServer, options?: ClientOptions) {
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => server.close());
  const client = new Client({ name: "mcm-test", version: "0.0.0" }, options);
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
