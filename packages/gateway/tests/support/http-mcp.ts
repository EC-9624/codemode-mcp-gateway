import {
  WebStandardStreamableHTTPServerTransport,
  type McpServer,
  type Server,
} from "@modelcontextprotocol/server";

/** A sessionful HTTP upstream on a loopback port, owned by one test. */
export async function httpMcp(
  server: McpServer | Server,
  intercept?: (request: Request) => Response | undefined,
) {
  await using setup = new AsyncDisposableStack();

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
  });

  setup.defer(() => server.close());
  await server.connect(transport);
  const requests: Request[] = [];

  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(request);

      return intercept?.(request) ?? transport.handleRequest(request);
    },
  });

  setup.defer(() => listener.stop(true));
  const cleanup = setup.move();

  return {
    url: new URL("/mcp", listener.url).toString(),
    transport,
    requests,
    [Symbol.asyncDispose]: () => cleanup.disposeAsync(),
  };
}
