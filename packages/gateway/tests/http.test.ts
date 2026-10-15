import { describe, expect, test } from "bun:test";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createMcpServer } from "./fixtures/mcp-tools.ts";
import { gatewayProcess } from "./support/gateway-process.ts";
import { rejectionOf } from "./support/rejection.ts";

describe("CMG HTTP upstream", () => {
  test("executes upstream calls using authentication supplied by the host environment", async () => {
    await using upstream = await httpMcp(createMcpServer(), (request) =>
      request.headers.get("Authorization") === "Bearer synthetic-token"
        ? undefined
        : new Response("Unauthorized", { status: 401 }),
    );

    await using app = await gatewayProcess({
      upstream: {
        type: "remote",
        url: upstream.url,
        headers: { Authorization: "Bearer {env:CMG_TEST_TOKEN}" },
      },
      environment: { CMG_TEST_TOKEN: "synthetic-token" },
    });

    await app.client.connect(app.transport, { timeout: 4_000 });
    await app.waitForConnections(1);

    const response = await app.client.callTool({
      name: "execute",
      arguments: {
        code: 'return (await tools["test.add"]({ a: 2, b: 3 })).structuredContent.sum;',
      },
    });

    expect(response.structuredContent).toEqual({
      result: { ok: true, value: 5 },
      calls: [{ callId: 1, name: "test.add", status: "completed" }],
    });
    expect(app.stderr).not.toContain("synthetic-token");
  }, 10_000);

  test("awaits authenticated HTTP session deletion before exiting on EOF", async () => {
    const deleting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const terminated = Promise.withResolvers<void>();

    await using upstream = await httpMcp(createMcpServer(), async (request) => {
      if (request.headers.get("Authorization") !== "Bearer synthetic-token") {
        return new Response("Unauthorized", { status: 401 });
      }

      if (request.method === "DELETE") {
        deleting.resolve();
        await release.promise;
      }
    });

    const onClose = upstream.transport.onclose;
    upstream.transport.onclose = () => {
      onClose?.();
      terminated.resolve();
    };

    await using app = await gatewayProcess({
      upstream: {
        type: "remote",
        url: upstream.url,
        headers: { Authorization: "Bearer {env:CMG_TEST_TOKEN}" },
      },
      environment: { CMG_TEST_TOKEN: "synthetic-token" },
    });

    await using gates = new AsyncDisposableStack();
    gates.defer(() => release.resolve());

    await app.client.connect(app.transport, { timeout: 4_000 });
    await app.waitForConnections(1);

    const session = upstream.transport.sessionId;
    expect(session).toBeDefined();

    app.child.stdin.end();

    await deleting.promise;
    // Give the child an opportunity to exit while the DELETE response is still blocked.
    expect(
      await Promise.race([app.closed.then(() => "closed"), Bun.sleep(100).then(() => "pending")]),
    ).toBe("pending");
    release.resolve();
    await terminated.promise;

    expect(await app.closed).toEqual({ code: 0, signal: null });
    const deletion = upstream.requests.find((request) => request.method === "DELETE");
    expect(deletion?.headers.get("mcp-session-id")).toBe(session);
    expect(deletion?.headers.get("Authorization")).toBe("Bearer synthetic-token");
    expect(app.stderr).not.toContain("synthetic-token");
  }, 10_000);

  test("cancels an HTTP call and recovers through the shared upstream connection", async () => {
    const server = new McpServer({ name: "cancellation-upstream", version: "1" });
    const started = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => stopped.resolve());

    server.registerTool(
      "wait",
      { inputSchema: z.object({ wait: z.boolean().optional() }) },
      async ({ wait }, { mcpReq }) => {
        if (wait !== true) {
          return { content: [], structuredContent: { recovered: true } };
        }

        using listeners = new DisposableStack();
        const onAbort = () => stopped.resolve();
        mcpReq.signal.addEventListener("abort", onAbort, { once: true });
        listeners.defer(() => mcpReq.signal.removeEventListener("abort", onAbort));
        started.resolve();
        await stopped.promise;

        return { content: [] };
      },
    );

    await using upstream = await httpMcp(server);
    await using app = await gatewayProcess({ upstream: { type: "remote", url: upstream.url } });
    await app.client.connect(app.transport, { timeout: 4_000 });
    await app.waitForConnections(1);
    const controller = new AbortController();

    const request = rejectionOf(
      app.client.callTool(
        {
          name: "execute",
          arguments: { code: 'return await tools["test.wait"]({ wait: true });' },
        },
        { signal: controller.signal },
      ),
    );

    await started.promise;
    controller.abort();
    await request;
    await stopped.promise;

    const response = await app.client.callTool({
      name: "execute",
      arguments: { code: 'return (await tools["test.wait"]({})).structuredContent;' },
    });

    expect(response.structuredContent).toMatchObject({
      result: { ok: true, value: { recovered: true } },
    });
    expect(upstream.transport.sessionId).toBeDefined();
  }, 10_000);

  test("requests cancellation and deletes the HTTP session during EOF shutdown", async () => {
    const server = new McpServer({ name: "shutdown-upstream", version: "1" });
    const started = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => stopped.resolve());

    server.registerTool("wait", {}, async ({ mcpReq }) => {
      using listeners = new DisposableStack();
      const onAbort = () => stopped.resolve();
      mcpReq.signal.addEventListener("abort", onAbort, { once: true });
      listeners.defer(() => mcpReq.signal.removeEventListener("abort", onAbort));
      started.resolve();
      await stopped.promise;

      return { content: [] };
    });

    await using upstream = await httpMcp(server);
    await using app = await gatewayProcess({ upstream: { type: "remote", url: upstream.url } });
    await app.client.connect(app.transport, { timeout: 4_000 });
    await app.waitForConnections(1);

    const request = rejectionOf(
      app.client.callTool({
        name: "execute",
        arguments: { code: 'return await tools["test.wait"]({});' },
      }),
    );

    await started.promise;
    app.child.stdin.end();

    await request;
    await stopped.promise;
    expect(await app.closed).toEqual({ code: 0, signal: null });
    expect(upstream.requests.some((request) => request.method === "DELETE")).toBe(true);
  }, 10_000);

  test("reports HTTP authentication failure without exposing the response body or credentials", async () => {
    await using upstream = await httpMcp(
      createMcpServer(),
      () => new Response("Private upstream challenge", { status: 401 }),
    );

    await using app = await gatewayProcess({
      upstream: {
        type: "remote",
        url: upstream.url,
        headers: { Authorization: "Bearer synthetic-token" },
      },
    });

    await app.client.connect(app.transport, { timeout: 4_000 });
    await app.waitFor('"state":"failed"');
    expect(await app.client.ping()).toEqual({});
    app.child.stdin.end();
    expect(await app.closed).toEqual({ code: 0, signal: null });
    expect(app.stderr).toContain("authentication");
    expect(app.stderr).not.toContain("Private upstream challenge");
    expect(app.stderr).not.toContain("synthetic-token");
  }, 10_000);

  test("rejects a missing header environment variable before contacting upstream", async () => {
    await using upstream = await httpMcp(createMcpServer());

    await using app = await gatewayProcess({
      upstream: {
        type: "remote",
        url: upstream.url,
        headers: { Authorization: "Bearer {env:CMG_TEST_MISSING_TOKEN}" },
      },
      environment: { CMG_TEST_MISSING_TOKEN: undefined },
    });

    await app.client.connect(app.transport, { timeout: 4_000 });
    await app.waitFor('"state":"failed"');
    app.child.stdin.end();
    expect(await app.closed).toEqual({ code: 0, signal: null });
    expect(app.stderr).toContain("Missing environment variable CMG_TEST_MISSING_TOKEN");
    expect(upstream.requests).toHaveLength(0);
  }, 10_000);

  test("terminates the HTTP session after catalog setup fails", async () => {
    const server = createMcpServer();
    // The high-level registration API cannot advertise this malformed wire schema.
    server.server.setRequestHandler("tools/list", () => ({
      tools: [{ name: "invalid", inputSchema: { type: "object", required: ["x", "x"] } }],
    }));

    await using upstream = await httpMcp(server);
    await using app = await gatewayProcess({ upstream: { type: "remote", url: upstream.url } });

    await app.client.connect(app.transport, { timeout: 4_000 });
    await app.waitFor('"state":"failed"');
    app.child.stdin.end();
    expect(await app.closed).toEqual({ code: 0, signal: null });
    expect(app.stderr).toContain("Upstream tool discovery failed");
    expect(upstream.requests.some((request) => request.method === "DELETE")).toBe(true);
  }, 10_000);
});

/** Own a sessionful loopback upstream; the test supplies handlers and intercepted responses. */
async function httpMcp(
  server: McpServer,
  intercept?: (request: Request) => Response | undefined | Promise<Response | undefined>,
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
    async fetch(request) {
      requests.push(request);

      return (await intercept?.(request)) ?? transport.handleRequest(request);
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
