import { describe, expect, test } from "bun:test";
import { createMcpServer } from "../fixtures/mcp-tools.ts";
import { httpMcp } from "../support/http-mcp.ts";
import { gatewayProcess } from "../support/gateway-process.ts";
import { toolServer } from "../support/mcp.ts";
import { rejectionOf } from "../support/rejection.ts";

describe("CMG HTTP upstream", () => {
  test("discovers and executes with environment-supplied authentication, then terminates its session", async () => {
    await using upstream = await httpMcp(createMcpServer(), (request) => {
      if (request.headers.get("Authorization") !== "Bearer synthetic-token") {
        return new Response("Unauthorized", { status: 401 });
      }
    });

    await using app = await gatewayProcess({
      upstream: {
        transport: "http",
        url: upstream.url,
        headers: { Authorization: "Bearer {env:CMG_TEST_TOKEN}" },
      },
      environment: { CMG_TEST_TOKEN: "synthetic-token" },
    });

    await app.client.connect(app.transport, { timeout: 4_000 });

    const discovery = await app.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools.searchTools({ query: "Add numbers" });' },
    });

    expect(discovery.structuredContent).toMatchObject({
      result: { ok: true, value: [{ name: "add", inputSchema: { required: ["a", "b"] } }] },
    });

    const response = await app.client.callTool({
      name: "execute",
      arguments: { code: "return (await tools.add({ a: 2, b: 3 })).structuredContent.sum;" },
    });

    expect(response.structuredContent).toEqual({
      result: { ok: true, value: 5 },
      calls: [{ callId: 1, name: "add", status: "completed" }],
    });
    const session = upstream.transport.sessionId;
    expect(session).toBeDefined();
    app.child.stdin.end();

    expect(await app.closed).toEqual({ code: 0, signal: null });
    const deletion = upstream.requests.find((request) => request.method === "DELETE");
    expect(deletion?.headers.get("mcp-session-id")).toBe(session);
    expect(deletion?.headers.get("Authorization")).toBe("Bearer synthetic-token");
    expect(app.stderr).not.toContain("synthetic-token");
  }, 10_000);

  test("cancels an HTTP call and recovers through the shared upstream connection", async () => {
    const server = toolServer([{ name: "wait", inputSchema: { type: "object" } }]);
    const started = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => stopped.resolve());

    server.setRequestHandler("tools/call", async ({ params }, { mcpReq }) => {
      if (params.arguments?.wait !== true) {
        return { content: [], structuredContent: { recovered: true } };
      }

      using listeners = new DisposableStack();
      const onAbort = () => stopped.resolve();
      mcpReq.signal.addEventListener("abort", onAbort, { once: true });
      listeners.defer(() => mcpReq.signal.removeEventListener("abort", onAbort));
      started.resolve();
      await stopped.promise;

      return { content: [] };
    });

    await using upstream = await httpMcp(server);
    await using app = await gatewayProcess({ upstream: { transport: "http", url: upstream.url } });
    await app.client.connect(app.transport, { timeout: 4_000 });
    const controller = new AbortController();

    const request = rejectionOf(
      app.client.callTool(
        {
          name: "execute",
          arguments: { code: "return await tools.wait({ wait: true });" },
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
      arguments: { code: "return (await tools.wait({})).structuredContent;" },
    });

    expect(response.structuredContent).toMatchObject({
      result: { ok: true, value: { recovered: true } },
    });
    expect(upstream.transport.sessionId).toBeDefined();
  }, 10_000);

  test("requests cancellation and deletes the HTTP session during EOF shutdown", async () => {
    const server = toolServer([{ name: "wait", inputSchema: { type: "object" } }]);
    const started = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => stopped.resolve());

    server.setRequestHandler("tools/call", async (_request, { mcpReq }) => {
      using listeners = new DisposableStack();
      const onAbort = () => stopped.resolve();
      mcpReq.signal.addEventListener("abort", onAbort, { once: true });
      listeners.defer(() => mcpReq.signal.removeEventListener("abort", onAbort));
      started.resolve();
      await stopped.promise;

      return { content: [] };
    });

    await using upstream = await httpMcp(server);
    await using app = await gatewayProcess({ upstream: { transport: "http", url: upstream.url } });
    await app.client.connect(app.transport, { timeout: 4_000 });

    const request = rejectionOf(
      app.client.callTool({ name: "execute", arguments: { code: "return await tools.wait();" } }),
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
        transport: "http",
        url: upstream.url,
        headers: { Authorization: "Bearer synthetic-token" },
      },
    });

    await rejectionOf(app.client.connect(app.transport, { timeout: 4_000 }));

    expect(await app.closed).toEqual({ code: 1, signal: null });
    expect(app.stderr).toContain("authentication");
    expect(app.stderr).not.toContain("Private upstream challenge");
    expect(app.stderr).not.toContain("synthetic-token");
  }, 10_000);

  test("rejects a missing header environment variable before contacting upstream", async () => {
    await using upstream = await httpMcp(createMcpServer());

    await using app = await gatewayProcess({
      upstream: {
        transport: "http",
        url: upstream.url,
        headers: { Authorization: "Bearer {env:CMG_TEST_MISSING_TOKEN}" },
      },
      environment: { CMG_TEST_MISSING_TOKEN: undefined },
    });

    await rejectionOf(app.client.connect(app.transport, { timeout: 4_000 }));

    expect(await app.closed).toEqual({ code: 1, signal: null });
    expect(app.stderr).toContain("Missing environment variable CMG_TEST_MISSING_TOKEN");
    expect(upstream.requests).toHaveLength(0);
  }, 10_000);

  test("terminates the HTTP session after catalog setup fails", async () => {
    const server = toolServer([
      { name: "invalid", inputSchema: { type: "object", required: ["x", "x"] } },
    ]);

    await using upstream = await httpMcp(server);
    await using app = await gatewayProcess({ upstream: { transport: "http", url: upstream.url } });

    await rejectionOf(app.client.connect(app.transport, { timeout: 4_000 }));

    expect(await app.closed).toEqual({ code: 1, signal: null });
    expect(app.stderr).toContain("Upstream tool discovery failed");
    expect(upstream.requests.some((request) => request.method === "DELETE")).toBe(true);
  }, 10_000);
});
