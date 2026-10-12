import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createMcpServer } from "../fixtures/mcp-tools";
import { createMcpCatalog } from "@cmg/mcp";
import { createServer } from "../../src/composition";
import { connectMcp, toolServer } from "../support/mcp";
import { rejectionOf } from "../support/rejection";

describe("MCP client through codemode to upstream MCP", () => {
  test("discovers a tool, describes its schema, and calls its exact name through JavaScript", async () => {
    await using upstream = await connectMcp(createMcpServer());
    const catalog = await createMcpCatalog(upstream.client);
    await using agent = await connectMcp(createServer(catalog));

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
    const upstreamServer = toolServer([{ name: "dataset", inputSchema: { type: "object" } }]);
    upstreamServer.setRequestHandler("tools/call", () => ({
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
    const upstreamServer = toolServer([{ name: "wait", inputSchema: { type: "object" } }]);
    const started = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const survivorStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => release.resolve());
    cleanup.defer(() => cancelled.resolve());

    upstreamServer.setRequestHandler("tools/call", async ({ params }, { mcpReq }) => {
      if (params.arguments?.cancel === true) {
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
    });

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
