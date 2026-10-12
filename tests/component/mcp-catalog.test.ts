import { describe, expect, spyOn, test } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020";
import { Client, StreamableHTTPClientTransport, type Tool } from "@modelcontextprotocol/client";
import { createMcpHandler, Server, type CallToolResult } from "@modelcontextprotocol/server";
import { createMcpServer } from "../../examples/mcp-tools";
import { ToolCatalog, ToolResult } from "../../src/codemode";
import { createMcpCatalog } from "../../src/mcp";
import { callTool } from "../../src/codemode/tools";
import { connectMcp, requireTool, toolServer } from "../support/mcp";
import { rejectionOf } from "../support/rejection";

const context = { signal: new AbortController().signal };

describe("MCP catalog discovery", () => {
  test("imports every page, preserves names and metadata, and routes the original name", async () => {
    const server = toolServer();
    const cursors: (string | undefined)[] = [];
    const invocations: unknown[] = [];

    server.setRequestHandler("tools/list", ({ params }) => {
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
    server.setRequestHandler("tools/call", ({ params }) => {
      invocations.push(params);

      return { content: [], structuredContent: { name: params.name } };
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
    expect(catalog.describe("__proto__")?.description).toBe("MCP tool: __proto__");
    expect(catalog.search("records").map((tool) => tool.name)).toEqual(["records.search"]);
    const invoke = requireTool(catalog, "__proto__");

    expect(await invoke(undefined, context)).toEqual({
      ok: true,
      value: { content: [], structuredContent: { name: "__proto__" } },
    });
    expect(invocations).toEqual([{ name: "__proto__", arguments: {} }]);
  });

  test("refreshes the upstream listing without changing an earlier catalog snapshot", async () => {
    const server = toolServer();
    let name = "first";
    let listings = 0;
    server.setRequestHandler("tools/list", () => {
      listings++;

      return { tools: [{ name, inputSchema: { type: "object" } }], ttlMs: 60_000 };
    });

    await using connection = await connectMcp(server);
    const first = await createMcpCatalog(connection.client);
    name = "second";
    const second = await createMcpCatalog(connection.client);

    expect(listings).toBe(2);
    expect(Object.keys(first.tools)).toEqual(["first"]);
    expect(Object.keys(second.tools)).toEqual(["second"]);
  });

  test("rejects duplicate names across pages and leaves the borrowed client usable", async () => {
    const server = toolServer();
    const tools: Tool[] = [{ name: "duplicate", inputSchema: { type: "object" } }];
    server.setRequestHandler("tools/list", ({ params }) =>
      params?.cursor === undefined ? { tools, nextCursor: "second" } : { tools },
    );

    await using connection = await connectMcp(server);
    const rejected = await rejectionOf(createMcpCatalog(connection.client));

    expect(rejected.reason).toEqual(
      new Error('MCP tool discovery returned duplicate name "duplicate".'),
    );
    expect(await connection.client.ping()).toEqual({});
  });

  test("propagates the SDK page cap rather than returning its partial catalog", async () => {
    const server = toolServer();
    let pages = 0;
    server.setRequestHandler("tools/list", () => {
      pages++;

      return { tools: [], nextCursor: String(pages) };
    });

    await using connection = await connectMcp(server, { listMaxPages: 2 });
    const rejected = await rejectionOf(createMcpCatalog(connection.client));

    expect(rejected.reason).toMatchObject({ code: "LIST_PAGINATION_EXCEEDED" });
    expect(pages).toBe(2);
    expect(await connection.client.ping()).toEqual({});
  });

  test("requires a connected client", async () => {
    const client = new Client({ name: "disconnected", version: "1" });
    const rejected = await rejectionOf(createMcpCatalog(client));

    expect(rejected.reason).toEqual(new Error("Connect the MCP client before discovering tools."));
  });

  test("checks the discovery deadline after synchronous catalog setup", async () => {
    await using connection = await connectMcp(createMcpServer());
    const create = ToolCatalog.create.bind(ToolCatalog);

    using compilation = spyOn(ToolCatalog, "create").mockImplementation((definitions) => {
      Bun.sleepSync(150);

      return create(definitions);
    });

    const rejected = await rejectionOf(createMcpCatalog(connection.client, { timeoutMs: 100 }));

    expect(rejected.reason).toEqual(new Error("MCP tool discovery exceeded the 100 ms limit."));
    expect(compilation).toHaveBeenCalledTimes(1);
    expect(await connection.client.ping()).toEqual({});
  });

  test("rejects a malformed wire listing rather than creating an empty catalog", async () => {
    await using connection = await connectMcp(createMcpServer());
    const send = connection.serverTransport.send.bind(connection.serverTransport);

    using fault = spyOn(connection.serverTransport, "send").mockImplementation((message) => {
      if ("result" in message && "tools" in message.result) {
        return send({ ...message, result: { tools: "malformed" } });
      }

      return send(message);
    });

    const rejected = await rejectionOf(createMcpCatalog(connection.client));

    expect(rejected.reason).toMatchObject({ code: "INVALID_RESULT" });
    expect(fault).toHaveBeenCalledTimes(1);
    expect(await connection.client.ping()).toEqual({});
  });

  test("preserves a discovery dependency failure and removes the caller listener", async () => {
    await using connection = await connectMcp(createMcpServer());
    const failure = new Error("Private listing failure");
    const controller = new AbortController();
    using listing = spyOn(connection.client, "listTools").mockRejectedValue(failure);
    using added = spyOn(controller.signal, "addEventListener");
    using removed = spyOn(controller.signal, "removeEventListener");

    const rejected = await rejectionOf(
      createMcpCatalog(connection.client, { signal: controller.signal }),
    );

    expect(rejected.reason).toBe(failure);
    const listener = added.mock.calls.find(([event]) => event === "abort")?.[1];
    expect(listener).toBeDefined();
    expect(removed).toHaveBeenCalledWith("abort", listener);
    expect(listing).toHaveBeenCalledTimes(1);
    expect(await connection.client.ping()).toEqual({});
  });

  test("returns an empty catalog without listing when the server has no tools capability", async () => {
    await using connection = await connectMcp(new Server({ name: "empty", version: "1" }));
    using listing = spyOn(connection.client, "listTools");
    const catalog = await createMcpCatalog(connection.client);

    expect(Object.keys(catalog.tools)).toEqual([]);
    expect(listing).not.toHaveBeenCalled();
  });

  test.each([0, -1, 1.5, NaN, Infinity, 2 ** 31])(
    "rejects invalid discovery timeout %s before cancellation or I/O",
    async (timeoutMs) => {
      const client = new Client({ name: "invalid", version: "1" });
      using listing = spyOn(client, "listTools");

      const rejected = await rejectionOf(
        createMcpCatalog(client, { timeoutMs, signal: AbortSignal.abort() }),
      );

      expect(rejected.reason).toBeInstanceOf(RangeError);
      expect(listing).not.toHaveBeenCalled();
    },
  );

  test("pre-aborted discovery preserves the host reason and does no I/O", async () => {
    await using connection = await connectMcp(createMcpServer());
    using listing = spyOn(connection.client, "listTools");
    const reason = new Error("Private discovery cancellation");

    const rejected = await rejectionOf(
      createMcpCatalog(connection.client, { signal: AbortSignal.abort(reason) }),
    );

    expect(rejected.reason).toBe(reason);
    expect(listing).not.toHaveBeenCalled();
  });

  test("removes the caller's abort listener after successful discovery", async () => {
    await using connection = await connectMcp(createMcpServer());
    const controller = new AbortController();
    using added = spyOn(controller.signal, "addEventListener");
    using removed = spyOn(controller.signal, "removeEventListener");

    await createMcpCatalog(connection.client, { signal: controller.signal });

    const listener = added.mock.calls.find(([event]) => event === "abort")?.[1];
    expect(listener).toBeDefined();
    expect(removed).toHaveBeenCalledWith("abort", listener);
    controller.abort();
    expect(await connection.client.ping()).toEqual({});
  });

  test("cancellation stops discovery on a later page and keeps the client open", async () => {
    const server = toolServer();
    const started = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const controller = new AbortController();
    let listings = 0;
    server.setRequestHandler("tools/list", async (_request, { mcpReq }) => {
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
    using removed = spyOn(controller.signal, "removeEventListener");

    const rejection = rejectionOf(
      createMcpCatalog(connection.client, {
        timeoutMs: 1000,
        signal: controller.signal,
      }),
    );

    await started.promise;
    controller.abort(new Error("Discovery stopped"));

    const rejected = await rejection;
    await stopped.promise;

    expect(rejected.reason).toBeInstanceOf(Error);
    expect(listings).toBe(2);
    expect(removed).toHaveBeenCalled();
    expect(await connection.client.ping()).toEqual({});
  });

  test("the overall discovery deadline cancels a pending listing without closing the client", async () => {
    const server = toolServer();
    const stopped = Promise.withResolvers<void>();
    server.setRequestHandler("tools/list", async (_request, { mcpReq }) => {
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

describe("MCP invocation boundary", () => {
  test("compiles JSON input schemas at discovery rather than per invocation", async () => {
    await using connection = await connectMcp(createMcpServer());
    using compilation = spyOn(Ajv2020.prototype, "compile");
    const catalog = await createMcpCatalog(connection.client);
    const count = compilation.mock.calls.length;
    const add = requireTool(catalog, "add");

    expect(await add({ a: 1, b: 2 }, context)).toMatchObject({
      ok: true,
      value: { structuredContent: { sum: 3 } },
    });
    expect(await add({ a: 3, b: 4 }, context)).toMatchObject({
      ok: true,
      value: { structuredContent: { sum: 7 } },
    });
    expect(count).toBeGreaterThan(0);
    expect(compilation).toHaveBeenCalledTimes(count);
  });

  test("rejects schema-invalid objects before upstream dispatch and preserves valid arguments", async () => {
    await using connection = await connectMcp(createMcpServer());
    const catalog = await createMcpCatalog(connection.client);
    using invocation = spyOn(connection.client, "callTool");
    const add = requireTool(catalog, "add");

    expect(await add({ a: "1", b: 2 }, context)).toEqual(
      ToolResult.failure('Invalid arguments for "add": /a must be number.'),
    );
    expect(invocation).not.toHaveBeenCalled();
    const args = { a: 1, b: 2 };
    expect(await add(args, context)).toMatchObject({
      ok: true,
      value: { structuredContent: { sum: 3 } },
    });
    expect(invocation).toHaveBeenCalledTimes(1);
    expect(invocation.mock.calls[0]?.[0].arguments).toBe(args);
  });

  test("normalizes omitted MCP arguments before validating the object schema", async () => {
    await using connection = await connectMcp(createMcpServer());
    const catalog = await createMcpCatalog(connection.client);
    using invocation = spyOn(connection.client, "callTool");
    const fail = requireTool(catalog, "fail");

    expect(await fail(undefined, context)).toEqual({
      ok: true,
      value: { content: [{ type: "text", text: "Synthetic tool failure." }], isError: true },
    });
    expect(invocation.mock.calls[0]?.[0]).toEqual({ name: "fail", arguments: {} });
  });

  test("fails catalog construction for an invalid upstream schema without closing the client", async () => {
    const server = toolServer([
      {
        name: "read",
        inputSchema: { type: "object", properties: { id: { type: "string", minLength: -1 } } },
      },
    ]);

    await using connection = await connectMcp(server);
    const rejected = await rejectionOf(createMcpCatalog(connection.client));

    expect(rejected.reason).toBeInstanceOf(Error);
    if (!(rejected.reason instanceof Error)) throw new Error("Expected setup failure");

    expect(rejected.reason.message).toContain('Invalid input schema for tool "read"');
    expect(rejected.reason.cause).toBeInstanceOf(Error);
    expect(await connection.client.ping()).toEqual({});
  });

  test.each([null, [], 42, "text", true])(
    "rejects non-object argument %j before upstream dispatch",
    async (args) => {
      await using connection = await connectMcp(createMcpServer());
      const catalog = await createMcpCatalog(connection.client);
      using invocation = spyOn(connection.client, "callTool");
      const add = requireTool(catalog, "add");

      expect(await add(args, context)).toEqual({
        ok: false,
        error: { message: "MCP tool arguments must be an object." },
      });
      expect(invocation).not.toHaveBeenCalled();
    },
  );

  test("does not send a request when its invocation signal is already aborted", async () => {
    await using connection = await connectMcp(createMcpServer());
    const catalog = await createMcpCatalog(connection.client);
    using invocation = spyOn(connection.client, "callTool");
    const add = requireTool(catalog, "add");

    expect(await callTool(add, { a: 1, b: 2 }, { signal: AbortSignal.abort() })).toEqual({
      ok: false,
      error: { message: "Host tool failed." },
    });
    expect(invocation).not.toHaveBeenCalled();
  });

  test("preserves mixed content and error data while excluding top-level metadata and extensions", async () => {
    const server = toolServer([{ name: "read", inputSchema: { type: "object" } }]);

    const content: CallToolResult["content"] = [
      { type: "text", text: "Public explanation", _meta: { publicBlockMetadata: true } },
      { type: "image", data: "AA==", mimeType: "image/png" },
      { type: "resource_link", name: "record", uri: "test://record" },
    ];

    server.setRequestHandler("tools/call", () => ({
      content,
      structuredContent: { detail: "public" },
      isError: true,
      _meta: { private: true },
      extension: "private",
    }));

    await using connection = await connectMcp(server);
    const catalog = await createMcpCatalog(connection.client);
    const read = requireTool(catalog, "read");

    expect(await read(undefined, context)).toEqual({
      ok: true,
      value: { content, structuredContent: { detail: "public" }, isError: true },
    });
  });

  test.each([null, false, 0, "", [1, 2]])(
    "preserves modern structured JSON value %j",
    async (structuredContent) => {
      const handler = createMcpHandler(() => {
        const server = toolServer([{ name: "read", inputSchema: { type: "object" } }]);
        server.setRequestHandler("tools/call", () => ({
          content: [],
          structuredContent,
          isError: false,
        }));

        return server;
      });

      await using cleanup = new AsyncDisposableStack();
      cleanup.defer(() => handler.close());

      const client = new Client(
        { name: "modern-test", version: "1" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );

      cleanup.defer(() => client.close());
      await client.connect(
        new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
          fetch: (url, init) => handler.fetch(new Request(url.toString(), init)),
        }),
      );
      const catalog = await createMcpCatalog(client);
      const read = requireTool(catalog, "read");

      expect(await read(undefined, context)).toEqual({
        ok: true,
        value: { content: [], structuredContent, isError: false },
      });
    },
  );

  test("uses SDK output-schema validation and keeps its failure generic at the host boundary", async () => {
    const server = toolServer([
      {
        name: "read",
        inputSchema: { type: "object" },
        outputSchema: {
          type: "object",
          required: ["sum"],
          properties: { sum: { type: "number" } },
        },
      },
    ]);

    server.setRequestHandler("tools/call", () => ({
      content: [],
      structuredContent: { sum: "invalid" },
    }));

    await using connection = await connectMcp(server);
    const catalog = await createMcpCatalog(connection.client);
    const read = requireTool(catalog, "read");

    expect(await callTool(read, {}, context)).toEqual({
      ok: false,
      error: { message: "Host tool failed." },
    });
  });
});
