import { describe, expect, spyOn, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { ToolCatalog, ToolResult } from "@cmg/codemode";
import { z } from "zod";
import { createMcpServer } from "./fixtures/mcp-tools.ts";
import { createMcpCatalog } from "@cmg/mcp";
import { createServer } from "codemode-mcp-gateway";
import { rejectionOf } from "./support/rejection.ts";

describe("MCP client through codemode to upstream MCP", () => {
  test.each(["searchTools", "describeTool"])("rejects a tool that would replace %s", (name) => {
    const catalog = ToolCatalog.create({
      [name]: { description: "Conflicting upstream", execute: () => ToolResult.success() },
    });

    expect(() => createServer(catalog)).toThrow(
      `Upstream tool ${JSON.stringify(name)} conflicts with a CMG discovery helper.`,
    );
  });

  test("rejects invalid fixed policy before returning a server", () => {
    const catalog = ToolCatalog.create({});

    expect(() => createServer(catalog, { maxToolCalls: 0 })).toThrow(RangeError);
  });

  test("charges discovery calls to the supplied execution budget", async () => {
    const catalog = ToolCatalog.create({
      read: { description: "Read records", execute: () => ToolResult.success(42) },
    });

    await using agent = await connectMcp(createServer(catalog, { maxToolCalls: 1 }));

    const response = await agent.client.callTool({
      name: "execute",
      arguments: {
        code: 'await tools.searchTools({ query: "records" }); return await tools.read();',
      },
    });

    expect(response.structuredContent).toEqual({
      result: {
        ok: false,
        error: {
          kind: "limit",
          resource: "tool-calls",
          maximum: 1,
          message: "Execution exceeded the 1 tool-call limit.",
        },
      },
      calls: [{ callId: 1, name: "searchTools", status: "completed" }],
    });
  });

  test("closing the composed server leaves its caller-owned upstream connection usable", async () => {
    await using upstream = await connectMcp(createMcpServer());
    const catalog = await createMcpCatalog(upstream.client);
    const server = createServer(catalog);
    await using agent = await connectMcp(server);
    expect(await agent.client.ping()).toEqual({});

    await server.close();
    const response = await upstream.client.callTool({ name: "add", arguments: { a: 2, b: 3 } });

    expect(response.structuredContent).toEqual({ sum: 5 });
  });

  test("close cancels active tools and waits for actual worker termination", async () => {
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const terminating = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const catalog = ToolCatalog.create({
      wait: {
        description: "Wait for cancellation",
        execute: async (_args, { signal }) => {
          using listeners = new DisposableStack();
          const onAbort = () => aborted.resolve();
          signal.addEventListener("abort", onAbort, { once: true });
          listeners.defer(() => signal.removeEventListener("abort", onAbort));
          started.resolve();
          await aborted.promise;

          return ToolResult.failure("Stopped");
        },
      },
    });

    const server = createServer(catalog, { timeoutMs: 5000 });
    await using agent = await connectMcp(server);
    await using gates = new AsyncDisposableStack();
    gates.defer(() => release.resolve());
    // Real worker termination needs a narrow gate to distinguish awaiting cleanup from requesting it.
    using termination = spyOn(Worker.prototype, "terminate");
    const terminate = termination.getMockImplementation();
    if (terminate === undefined) throw new Error("Expected native terminate");

    termination.mockImplementation(async function (this: Worker) {
      terminating.resolve();
      await release.promise;

      return terminate.call(this);
    });

    const request = rejectionOf(
      agent.client.callTool({ name: "execute", arguments: { code: "return await tools.wait();" } }),
    );

    await started.promise;
    let closed = false;

    const closing = server.close().then(() => {
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

  test("discovers a tool, describes its schema, and calls its exact name through JavaScript", async () => {
    await using upstream = await connectMcp(createMcpServer());
    const catalog = await createMcpCatalog(upstream.client);
    await using agent = await connectMcp(createServer(catalog));

    const listing = await agent.client.listTools();
    expect(listing.tools.map((tool) => tool.name)).toEqual(["execute"]);
    expect(listing.tools[0]?.description).toContain("tools.searchTools");
    expect(listing.tools[0]?.description).toContain("tools.describeTool");

    const search = await agent.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools.searchTools({ query: "Add numbers" });' },
    });

    const discovered = z
      .object({
        result: z.object({
          ok: z.literal(true),
          value: z.array(z.object({ name: z.string() })).min(1),
        }),
      })
      .parse(search.structuredContent);

    const name = discovered.result.value[0]?.name;
    if (name === undefined) throw new Error("Expected a discovered tool");

    const description = await agent.client.callTool({
      name: "execute",
      arguments: { code: `return await tools.describeTool({ name: ${JSON.stringify(name)} });` },
    });

    expect(description.structuredContent).toMatchObject({
      result: { ok: true, value: { name: "add", inputSchema: { required: ["a", "b"] } } },
    });

    const result = await agent.client.callTool({
      name: "execute",
      arguments: {
        code: `return (await tools[${JSON.stringify(name)}]({ a: 2, b: 3 })).structuredContent.sum;`,
      },
    });

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      result: { ok: true, value: 5 },
      calls: [{ callId: 1, name: "add", status: "completed" }],
    });
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(result.structuredContent) },
    ]);
  });

  test("processes an upstream dataset in QuickJS without forwarding retained tool bodies", async () => {
    const upstreamServer = new McpServer({ name: "dataset-upstream", version: "1" });
    upstreamServer.registerTool("dataset", {}, () => ({
      content: [],
      structuredContent: {
        records: Array.from({ length: 3000 }, (_, id) => ({ id, text: "private payload" })),
      },
    }));

    await using upstream = await connectMcp(upstreamServer);
    const catalog = await createMcpCatalog(upstream.client);
    await using agent = await connectMcp(createServer(catalog, { maxOutputBytes: 4 }));

    const response = await agent.client.callTool({
      name: "execute",
      arguments: { code: "return (await tools.dataset()).structuredContent.records.length;" },
    });

    expect(response.isError).toBe(false);
    expect(response.structuredContent).toEqual({
      result: { ok: true, value: 3000 },
      calls: [{ callId: 1, name: "dataset", status: "completed" }],
    });
    expect(response.content).toEqual([
      { type: "text", text: JSON.stringify(response.structuredContent) },
    ]);
    expect(JSON.stringify(response)).not.toContain("private payload");
  });

  test("recovers from a guest script failure and calls upstream through the same server", async () => {
    await using upstream = await connectMcp(createMcpServer());
    const catalog = await createMcpCatalog(upstream.client);
    await using agent = await connectMcp(createServer(catalog));

    const failed = await agent.client.callTool({
      name: "execute",
      arguments: { code: 'await tools.add({ a: 2, b: 3 }); throw new Error("Script failed");' },
    });

    const recovered = await agent.client.callTool({
      name: "execute",
      arguments: { code: "return (await tools.add({ a: 4, b: 5 })).structuredContent.sum;" },
    });

    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toEqual({
      result: { ok: false, error: { kind: "script", message: "Script failed" } },
      calls: [{ callId: 1, name: "add", status: "completed" }],
    });
    expect(recovered.isError).toBe(false);
    expect(recovered.structuredContent).toEqual({
      result: { ok: true, value: 9 },
      calls: [{ callId: 1, name: "add", status: "completed" }],
    });
  });

  test("request cancellation reaches upstream without cancelling another execution", async () => {
    const upstreamServer = new McpServer({ name: "cancellation-upstream", version: "1" });
    const started = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const survivorStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => release.resolve());
    cleanup.defer(() => cancelled.resolve());

    upstreamServer.registerTool(
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

    await using upstream = await connectMcp(upstreamServer);
    const catalog = await createMcpCatalog(upstream.client);

    await using agent = await connectMcp(createServer(catalog, { timeoutMs: 5000 }));

    const controller = new AbortController();

    const first = rejectionOf(
      agent.client.callTool(
        {
          name: "execute",
          arguments: { code: "return await tools.wait({ cancel: true });" },
        },
        { signal: controller.signal },
      ),
    );

    const second = agent.client.callTool({
      name: "execute",
      arguments: { code: "return (await tools.wait({})).structuredContent;" },
    });

    await Promise.all([started.promise, survivorStarted.promise]);
    controller.abort();
    await first;
    await cancelled.promise;
    release.resolve();

    expect((await second).structuredContent).toMatchObject({
      result: { ok: true, value: { cancelled: false } },
    });
    expect(await upstream.client.ping()).toEqual({});
  });
});

/** Own both ends, including partially completed setup; handlers remain in each test. */
async function connectMcp(server: McpServer) {
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => server.close());
  const client = new Client({ name: "cmg-test", version: "0.0.0" });
  cleanup.defer(() => client.close());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport, { timeout: 1_000 });
  const owned = cleanup.move();

  return { client, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}
