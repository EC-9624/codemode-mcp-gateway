import { describe, expect, spyOn, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  type McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { Configuration, Gateway, type ConfigurationInput } from "codemode-mcp-gateway";
import { createMcpServer } from "./fixtures/mcp-tools.ts";
import { rejectionOf } from "./support/rejection.ts";

describe("gateway execution", () => {
  test("the advertised discovery example runs and exact discovered names remain callable", async () => {
    await using app = await connectGateway(createMcpServer());
    const listing = await app.client.listTools();
    const description = listing.tools[0]?.description;
    const example = description?.match(/`(return await tools\.searchTools\([^`]+)`/)?.[1];
    if (example === undefined) throw new Error("Missing runnable discovery example.");

    const sample = await app.client.callTool({ name: "execute", arguments: { code: example } });

    const result = await app.client.callTool({
      name: "execute",
      arguments: {
        code: `
      const page = await tools.searchTools({ query: "Add numbers" });
      const name = page.tools[0].name;
      const description = await tools.describeTool({ name });
      const response = await tools[name]({ a: 2, b: 3 });
      return { name, required: description.inputSchema.required, sum: response.structuredContent.sum };
    `,
      },
    });

    expect(listing.tools.map((tool) => tool.name)).toEqual(["execute"]);
    expect(description).toContain("check isError");
    expect(description).toContain("## Availability");
    expect(sample.structuredContent).toMatchObject({
      result: {
        ok: true,
        value: { tools: [], total: 0, servers: [{ name: "test", state: "connected" }] },
      },
    });
    expect(result.structuredContent).toEqual({
      result: { ok: true, value: { name: "test.add", required: ["a", "b"], sum: 5 } },
      calls: [
        { callId: 1, name: "searchTools", status: "completed" },
        { callId: 2, name: "describeTool", status: "completed" },
        { callId: 3, name: "test.add", status: "completed" },
      ],
    });
  });

  test("charges discovery calls to the supplied execution budget", async () => {
    await using app = await connectGateway(createMcpServer(), { maxToolCalls: 1 });

    const response = await app.client.callTool({
      name: "execute",
      arguments: {
        code: 'await tools.searchTools({ query: "add" }); return await tools["test.add"]({ a: 1, b: 2 });',
      },
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      result: { ok: false, error: { kind: "limit", resource: "tool-calls", maximum: 1 } },
      calls: [{ callId: 1, name: "searchTools", status: "completed" }],
    });
  });

  test("shares capacity across MCP instances and admits a later request after completion", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const upstream = createMcpServer();
    upstream.registerTool("wait", {}, async () => {
      calls++;
      started.resolve();
      await release.promise;

      return { content: [], structuredContent: { value: 42 } };
    });
    await using app = await connectGateway(upstream, { maxConcurrentExecutions: 1 });
    await using second = await connectMcp(app.gateway.createServer());
    using gates = new DisposableStack();
    gates.defer(() => release.resolve());

    const running = app.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools["test.wait"]({});' },
    });

    await started.promise;

    const rejected = await second.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools["test.wait"]({});' },
    });

    expect(rejected.structuredContent).toMatchObject({
      result: { ok: false, error: { kind: "limit", resource: "executions", maximum: 1 } },
      calls: [],
    });
    expect(calls).toBe(1);
    release.resolve();
    expect((await running).isError).toBe(false);

    const recovered = await second.client.callTool({
      name: "execute",
      arguments: { code: "return 7;" },
    });

    expect(recovered.structuredContent).toEqual({ result: { ok: true, value: 7 }, calls: [] });
  });

  test("closing one MCP instance leaves the gateway's upstream usable by another", async () => {
    await using app = await connectGateway(createMcpServer());
    await using other = await connectMcp(app.gateway.createServer());
    await app.server.close();

    const response = await other.client.callTool({
      name: "execute",
      arguments: {
        code: 'return (await tools["test.add"]({ a: 2, b: 3 })).structuredContent.sum;',
      },
    });

    expect(response.structuredContent).toMatchObject({ result: { ok: true, value: 5 } });
    expect(app.gateway.status()).toMatchObject([{ state: "connected" }]);
  });

  test("gateway close cancels active tools and waits for actual worker termination", async () => {
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const terminating = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const upstream = createMcpServer();
    upstream.registerTool("wait", {}, async ({ mcpReq }) => {
      using listeners = new DisposableStack();
      const abort = () => aborted.resolve();
      mcpReq.signal.addEventListener("abort", abort, { once: true });
      listeners.defer(() => mcpReq.signal.removeEventListener("abort", abort));
      started.resolve();
      await aborted.promise;

      return { content: [], isError: true };
    });
    await using app = await connectGateway(upstream);
    using gates = new DisposableStack();
    gates.defer(() => release.resolve());
    // Real worker termination needs a gate to distinguish awaiting exit from requesting it.
    using termination = spyOn(Worker.prototype, "terminate");
    const terminate = termination.getMockImplementation();
    if (terminate === undefined) throw new Error("Expected native terminate");

    termination.mockImplementation(async function (this: Worker) {
      terminating.resolve();
      await release.promise;

      return terminate.call(this);
    });

    const request = rejectionOf(
      app.client.callTool({
        name: "execute",
        arguments: { code: 'return await tools["test.wait"]({});' },
      }),
    );

    await started.promise;
    let closed = false;

    const closing = app.gateway.close().then(() => {
      closed = true;
    });

    await aborted.promise;
    await terminating.promise;
    expect(closed).toBe(false);
    release.resolve();
    await closing;
    await request;
    expect(closed).toBe(true);
    expect(termination).toHaveBeenCalledTimes(1);
  });

  test("processes a large upstream dataset and exposes only selected output and call summaries", async () => {
    const upstream = createMcpServer();
    upstream.registerTool("dataset", {}, () => ({
      content: [],
      structuredContent: {
        records: Array.from({ length: 3000 }, (_, id) => ({ id, text: "private payload" })),
      },
    }));
    await using app = await connectGateway(upstream, { maxOutputBytes: 4 });

    const response = await app.client.callTool({
      name: "execute",
      arguments: {
        code: 'return (await tools["test.dataset"]({})).structuredContent.records.length;',
      },
    });

    expect(response.structuredContent).toEqual({
      result: { ok: true, value: 3000 },
      calls: [{ callId: 1, name: "test.dataset", status: "completed" }],
    });
    expect(response.content).toEqual([
      { type: "text", text: JSON.stringify(response.structuredContent) },
    ]);
    expect(JSON.stringify(response)).not.toContain("private payload");
  });

  test("recovers from a guest script failure through the same gateway", async () => {
    await using app = await connectGateway(createMcpServer());

    const failed = await app.client.callTool({
      name: "execute",
      arguments: {
        code: 'await tools["test.add"]({ a: 2, b: 3 }); throw new Error("Script failed");',
      },
    });

    const recovered = await app.client.callTool({
      name: "execute",
      arguments: {
        code: 'return (await tools["test.add"]({ a: 4, b: 5 })).structuredContent.sum;',
      },
    });

    expect(failed.structuredContent).toEqual({
      result: { ok: false, error: { kind: "script", message: "Script failed" } },
      calls: [{ callId: 1, name: "test.add", status: "completed" }],
    });
    expect(recovered.structuredContent).toMatchObject({ result: { ok: true, value: 9 } });
  });

  test("request cancellation reaches upstream without cancelling another execution", async () => {
    const started = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const survivorStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const upstream = createMcpServer();
    upstream.registerTool(
      "wait",
      { inputSchema: z.object({ cancel: z.boolean().optional() }) },
      async ({ cancel }, { mcpReq }) => {
        if (cancel === true) {
          using listeners = new DisposableStack();
          const abort = () => cancelled.resolve();
          mcpReq.signal.addEventListener("abort", abort, { once: true });
          listeners.defer(() => mcpReq.signal.removeEventListener("abort", abort));
          started.resolve();
          await cancelled.promise;

          return { content: [], isError: true };
        }

        survivorStarted.resolve();
        await release.promise;

        return { content: [], structuredContent: { cancelled: mcpReq.signal.aborted } };
      },
    );
    await using app = await connectGateway(upstream);
    using gates = new DisposableStack();
    gates.defer(() => release.resolve());
    gates.defer(() => cancelled.resolve());
    const controller = new AbortController();

    const first = rejectionOf(
      app.client.callTool(
        {
          name: "execute",
          arguments: { code: 'return await tools["test.wait"]({ cancel: true });' },
        },
        { signal: controller.signal },
      ),
    );

    const second = app.client.callTool({
      name: "execute",
      arguments: { code: 'return (await tools["test.wait"]({})).structuredContent;' },
    });

    await Promise.all([started.promise, survivorStarted.promise]);
    controller.abort();
    await first;
    await cancelled.promise;
    release.resolve();

    expect((await second).structuredContent).toMatchObject({
      result: { ok: true, value: { cancelled: false } },
    });
    expect(app.gateway.status()).toMatchObject([{ state: "connected" }]);
  });
});

/** Own a real HTTP upstream and gateway; scenarios supply handlers and policy. */
async function connectGateway(upstream: McpServer, sandbox: ConfigurationInput["sandbox"] = {}) {
  await using setup = new AsyncDisposableStack();
  setup.defer(() => upstream.close());

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
  });

  await upstream.connect(transport);

  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => transport.handleRequest(request),
  });

  setup.defer(() => listener.stop(true));

  const gateway = setup.use(
    new Gateway(
      Configuration.parse({
        mcp: { servers: { test: { type: "remote", url: listener.url.href } } },
        sandbox,
      }),
      ".",
    ),
  );

  await gateway.start();
  const server = gateway.createServer();
  const agent = setup.use(await connectMcp(server));
  const cleanup = setup.move();

  return {
    gateway,
    server,
    client: agent.client,
    [Symbol.asyncDispose]: () => cleanup.disposeAsync(),
  };
}

async function connectMcp(server: McpServer) {
  await using setup = new AsyncDisposableStack();
  setup.defer(() => server.close());
  const client = new Client({ name: "gateway-test", version: "0" });
  setup.defer(() => client.close());
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote);
  await client.connect(local);
  const cleanup = setup.move();

  return { client, [Symbol.asyncDispose]: () => cleanup.disposeAsync() };
}
