import { describe, expect, spyOn, test } from "bun:test";
import { getEventListeners } from "node:events";
import { Client, type Tool } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { ToolResult } from "@codemode-mcp-gateway/codemode";
import { createMcpCatalog } from "@codemode-mcp-gateway/mcp";
import { createMcpServer } from "./fixtures/mcp-tools.ts";
import { connectMcp, requireTool, toolServer } from "./support/mcp.ts";
import { rejectionOf } from "./support/rejection.ts";

describe("createMcpCatalog discovery", () => {
  test("imports every page with the original names and metadata", async () => {
    const server = toolServer();
    const cursors: (string | undefined)[] = [];
    server.server.setRequestHandler("tools/list", ({ params }) => {
      cursors.push(params?.cursor);

      return params?.cursor === undefined
        ? {
            tools: [
              {
                name: "records.search",
                description: "Search records",
                inputSchema: { type: "object" },
              },
            ],
            nextCursor: "second",
          }
        : { tools: [{ name: "__proto__", inputSchema: { type: "object" } }] };
    });
    await using connection = await connectMcp(server);

    const catalog = await createMcpCatalog(connection.client);

    expect(cursors).toEqual([undefined, "second"]);
    expect(Object.keys(catalog.tools)).toEqual(["records.search", "__proto__"]);
    expect(catalog.describe("records.search")).toEqual({
      name: "records.search",
      description: "Search records",
      inputSchema: { type: "object" },
    });
    expect(catalog.describe("__proto__")).toEqual({
      name: "__proto__",
      description: "MCP tool: __proto__",
      inputSchema: { type: "object" },
    });
  });

  test("refreshes discovery without changing an earlier catalog snapshot", async () => {
    const server = toolServer();
    let name = "first";
    let listings = 0;
    const inputSchema = { type: "object" as const, properties: { tag: { enum: ["before"] } } };
    server.server.setRequestHandler("tools/list", () => {
      listings++;

      return { tools: [{ name, inputSchema }], ttlMs: 60_000 };
    });
    server.server.setRequestHandler("tools/call", ({ params }) => ({
      content: [],
      structuredContent: params.arguments,
    }));
    await using connection = await connectMcp(server);
    const first = await createMcpCatalog(connection.client);
    const context = { signal: new AbortController().signal };

    name = "second";
    inputSchema.properties.tag.enum[0] = "after";
    const second = await createMcpCatalog(connection.client);
    const original = await requireTool(first, "first")({ tag: "before" }, context);
    const refreshed = await requireTool(second, "second")({ tag: "before" }, context);

    expect(listings).toBe(2);
    expect(Object.keys(first.tools)).toEqual(["first"]);
    expect(Object.keys(second.tools)).toEqual(["second"]);
    expect(first.describe("first")?.inputSchema).toEqual({
      type: "object",
      properties: { tag: { enum: ["before"] } },
    });
    expect(original).toEqual({
      ok: true,
      value: { content: [], structuredContent: { tag: "before" } },
    });
    expect(refreshed).toEqual(
      ToolResult.failure(
        'Invalid arguments for "second": /tag must be equal to one of the allowed values.',
      ),
    );
  });

  test("rejects duplicate names across pages without closing the borrowed client", async () => {
    const server = toolServer();
    const tools: Tool[] = [{ name: "duplicate", inputSchema: { type: "object" } }];
    server.server.setRequestHandler("tools/list", ({ params }) =>
      params?.cursor === undefined ? { tools, nextCursor: "second" } : { tools },
    );
    await using connection = await connectMcp(server);

    const rejected = await rejectionOf(createMcpCatalog(connection.client));

    expect(rejected.reason).toEqual(
      new Error('MCP tool discovery returned duplicate name "duplicate".'),
    );
    expect(await connection.client.ping()).toEqual({});
  });

  test("rejects discovery when the client is disconnected", async () => {
    const client = new Client({ name: "disconnected", version: "1" });

    const rejected = await rejectionOf(createMcpCatalog(client));

    expect(rejected.reason).toEqual(new Error("Connect the MCP client before discovering tools."));
  });

  test("rejects an expired discovery before publication even when the timer has not run", async () => {
    await using connection = await connectMcp(createMcpServer());
    const now = performance.now();
    using clock = spyOn(performance, "now").mockReturnValue(now);
    const listTools = connection.client.listTools.bind(connection.client);

    using listing = spyOn(connection.client, "listTools").mockImplementation(async (...args) => {
      const response = await listTools(...args);
      clock.mockReturnValue(now + 101);

      return response;
    });

    const rejected = await rejectionOf(createMcpCatalog(connection.client, { timeoutMs: 100 }));

    expect(rejected.reason).toEqual(new Error("MCP tool discovery exceeded the 100 ms limit."));
    expect(listing).toHaveBeenCalledTimes(1);
    expect(await connection.client.ping()).toEqual({});
  });

  test("rejects a malformed wire listing instead of publishing an empty catalog", async () => {
    await using connection = await connectMcp(createMcpServer());
    const send = connection.serverTransport.send.bind(connection.serverTransport);

    using fault = spyOn(connection.serverTransport, "send").mockImplementation((message) => {
      if ("result" in message && "tools" in message.result)
        return send({ ...message, result: { tools: "malformed" } });

      return send(message);
    });

    const rejected = await rejectionOf(createMcpCatalog(connection.client));

    expect(rejected.reason).toMatchObject({ code: "INVALID_RESULT" });
    expect(await connection.client.ping()).toEqual({});
    expect(fault).toHaveBeenCalled();
  });

  test("preserves listing failure and releases the caller's cancellation listener", async () => {
    await using connection = await connectMcp(createMcpServer());
    const failure = new Error("Private listing failure");
    const controller = new AbortController();
    using listing = spyOn(connection.client, "listTools").mockRejectedValue(failure);

    const rejected = await rejectionOf(
      createMcpCatalog(connection.client, { signal: controller.signal }),
    );

    expect(rejected.reason).toBe(failure);
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
    expect(listing).toHaveBeenCalledTimes(1);
    expect(await connection.client.ping()).toEqual({});
  });

  test("returns an empty catalog without listing when tools capability is absent", async () => {
    await using connection = await connectMcp(new McpServer({ name: "empty", version: "1" }));
    using listing = spyOn(connection.client, "listTools");

    const catalog = await createMcpCatalog(connection.client);

    expect(Object.keys(catalog.tools)).toEqual([]);
    expect(listing).not.toHaveBeenCalled();
  });

  test.each([
    ["zero", 0],
    ["fractional", 1.5],
    ["overflowing", 2 ** 31],
  ] as const)("rejects a %s discovery deadline before I/O", async (_name, timeoutMs) => {
    const client = new Client({ name: "invalid", version: "1" });
    using listing = spyOn(client, "listTools");

    const rejected = await rejectionOf(
      createMcpCatalog(client, { timeoutMs, signal: AbortSignal.abort() }),
    );

    expect(rejected.reason).toBeInstanceOf(RangeError);
    expect(listing).not.toHaveBeenCalled();
  });

  test("preserves the host reason without I/O when discovery is already aborted", async () => {
    await using connection = await connectMcp(createMcpServer());
    const reason = new Error("Private discovery cancellation");
    using listing = spyOn(connection.client, "listTools");

    const rejected = await rejectionOf(
      createMcpCatalog(connection.client, { signal: AbortSignal.abort(reason) }),
    );

    expect(rejected.reason).toBe(reason);
    expect(listing).not.toHaveBeenCalled();
  });

  test("uses a fresh invocation signal after discovery cancellation is released", async () => {
    await using connection = await connectMcp(createMcpServer());
    const controller = new AbortController();
    const catalog = await createMcpCatalog(connection.client, { signal: controller.signal });
    const add = requireTool(catalog, "add");

    controller.abort();
    const result = await add({ a: 1, b: 2 }, { signal: new AbortController().signal });

    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
    expect(result).toEqual({
      ok: true,
      value: { content: [{ type: "text", text: '{"sum":3}' }], structuredContent: { sum: 3 } },
    });
  });

  test("cancels a later discovery page without closing the client", async () => {
    const server = toolServer();
    const started = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const controller = new AbortController();
    let listings = 0;
    server.server.setRequestHandler("tools/list", async (_request, { mcpReq }) => {
      listings++;
      if (listings === 1) return { tools: [], nextCursor: "second" };

      using cleanup = new DisposableStack();
      const abort = () => stopped.resolve();
      cleanup.defer(() => mcpReq.signal.removeEventListener("abort", abort));
      mcpReq.signal.addEventListener("abort", abort, { once: true });
      started.resolve();
      await stopped.promise;

      return { tools: [] };
    });
    await using connection = await connectMcp(server);
    using cleanup = new DisposableStack();
    cleanup.defer(() => stopped.resolve());

    const completion = rejectionOf(
      createMcpCatalog(connection.client, { timeoutMs: 1000, signal: controller.signal }),
    );

    await started.promise;
    controller.abort(new Error("Discovery stopped"));
    const rejected = await completion;
    await stopped.promise;

    expect(rejected.reason).toBeInstanceOf(Error);
    expect(listings).toBe(2);
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
    expect(await connection.client.ping()).toEqual({});
  });

  test("cancels a pending listing at the overall deadline without closing the client", async () => {
    const server = toolServer();
    const stopped = Promise.withResolvers<void>();
    server.server.setRequestHandler("tools/list", async (_request, { mcpReq }) => {
      using cleanup = new DisposableStack();
      const abort = () => stopped.resolve();
      cleanup.defer(() => mcpReq.signal.removeEventListener("abort", abort));
      mcpReq.signal.addEventListener("abort", abort, { once: true });
      await stopped.promise;

      return { tools: [] };
    });
    await using connection = await connectMcp(server);
    using cleanup = new DisposableStack();
    cleanup.defer(() => stopped.resolve());

    const rejected = await rejectionOf(createMcpCatalog(connection.client, { timeoutMs: 100 }));
    await stopped.promise;

    expect(rejected.reason).toBeInstanceOf(Error);
    if (!(rejected.reason instanceof Error)) throw new Error("Expected discovery error");

    expect(rejected.reason.message).toContain("MCP tool discovery exceeded the 100 ms limit.");
    expect(await connection.client.ping()).toEqual({});
  });
});
