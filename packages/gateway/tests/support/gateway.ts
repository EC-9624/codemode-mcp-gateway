import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { type McpServer } from "@modelcontextprotocol/server";

/** Own an in-memory agent connection without hiding the gateway scenario. */
export async function connect(server: McpServer) {
  await using setup = new AsyncDisposableStack();
  setup.defer(() => server.close());
  const client = new Client({ name: "multi-upstream-test", version: "0" });
  setup.defer(() => client.close());
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote);
  await client.connect(local);
  const cleanup = setup.move();

  return { client, [Symbol.asyncDispose]: () => cleanup.disposeAsync() };
}

export async function within<T>(promise: Promise<T>, ms = 4000): Promise<T> {
  const deadline = Promise.withResolvers<never>();

  const timer = setTimeout(
    () => deadline.reject(new Error("Expected gateway state transition did not arrive.")),
    ms,
  );

  try {
    return await Promise.race([promise, deadline.promise]);
  } finally {
    clearTimeout(timer);
  }
}
