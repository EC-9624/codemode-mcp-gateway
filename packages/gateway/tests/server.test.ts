import { describe, expect, spyOn, test } from "bun:test";
import { Worker } from "node:worker_threads";
import {
  type McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { Configuration, Gateway, type ConfigurationInput } from "codemode-mcp-gateway";
import { createMcpServer } from "./fixtures/mcp-tools.ts";
import { rejectionOf } from "./support/rejection.ts";
import { responseText, responseValue } from "./support/output.ts";
import { connect } from "./support/gateway.ts";

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
    expect(responseValue(sample)).toMatchObject({
      tools: [],
      total: 0,
      servers: [{ name: "test", state: "connected" }],
    });
    expect(responseValue(result)).toEqual({ name: "test.add", required: ["a", "b"], sum: 5 });
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
    expect(responseText(response)).toBe("Execution exceeded the 1 tool-call limit.");
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
    await using second = await connect(app.gateway.createServer());
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

    expect(rejected.isError).toBe(true);
    expect(responseText(rejected)).toBe("Executor reached the 1 concurrent-execution limit.");
    expect(calls).toBe(1);
    release.resolve();
    expect((await running).isError).toBeUndefined();

    const recovered = await second.client.callTool({
      name: "execute",
      arguments: { code: "return 7;" },
    });

    expect(responseValue(recovered)).toBe(7);
  });

  test("closing one MCP instance leaves the gateway's upstream usable by another", async () => {
    await using app = await connectGateway(createMcpServer());
    await using other = await connect(app.gateway.createServer());
    await app.server.close();

    const response = await other.client.callTool({
      name: "execute",
      arguments: {
        code: 'return (await tools["test.add"]({ a: 2, b: 3 })).structuredContent.sum;',
      },
    });

    expect(responseValue(response)).toBe(5);
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

  test("processes a large upstream dataset and exposes only selected output", async () => {
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

    expect(response).toEqual({ content: [{ type: "text", text: "3000" }] });
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

    expect(failed).toEqual({ content: [{ type: "text", text: "Script failed" }], isError: true });
    expect(responseValue(recovered)).toBe(9);
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

    expect(responseValue(await second)).toEqual({ cancelled: false });
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
  const agent = setup.use(await connect(server));
  const cleanup = setup.move();

  return {
    gateway,
    server,
    client: agent.client,
    [Symbol.asyncDispose]: () => cleanup.disposeAsync(),
  };
}
