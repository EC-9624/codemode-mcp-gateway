import { describe, expect, spyOn, test } from "bun:test";
import { Client, StreamableHTTPClientTransport, type Tool } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { createMcpServer } from "./fixtures/mcp-tools.ts";
import { CodeExecutor, ToolCatalog, ToolResult } from "@cmg/codemode";
import { createMcpCatalog } from "@cmg/mcp";
import { connectMcp, requireTool, toolServer } from "./support/mcp.ts";
import { rejectionOf } from "./support/rejection.ts";

const context = { signal: new AbortController().signal };

describe("MCP catalog discovery", () => {
  test("imports every page, preserves names and metadata, and routes the original name", async () => {
    const server = toolServer();
    const cursors: (string | undefined)[] = [];
    const invocations: unknown[] = [];

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
    server.server.setRequestHandler("tools/call", ({ params }) => {
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
    name = "second";
    inputSchema.properties.tag.enum[0] = "after";
    const second = await createMcpCatalog(connection.client);

    expect(listings).toBe(2);
    expect(Object.keys(first.tools)).toEqual(["first"]);
    expect(Object.keys(second.tools)).toEqual(["second"]);
    expect(first.describe("first")?.inputSchema).toEqual({
      type: "object",
      properties: { tag: { enum: ["before"] } },
    });
    expect(await requireTool(first, "first")({ tag: "before" }, context)).toEqual({
      ok: true,
      value: { content: [], structuredContent: { tag: "before" } },
    });
    expect(await requireTool(second, "second")({ tag: "before" }, context)).toEqual(
      ToolResult.failure(
        'Invalid arguments for "second": /tag must be equal to one of the allowed values.',
      ),
    );
  });

  test("rejects duplicate names across pages and leaves the borrowed client usable", async () => {
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

    using _fault = spyOn(connection.serverTransport, "send").mockImplementation((message) => {
      if ("result" in message && "tools" in message.result) {
        return send({ ...message, result: { tools: "malformed" } });
      }

      return send(message);
    });

    const rejected = await rejectionOf(createMcpCatalog(connection.client));

    expect(rejected.reason).toMatchObject({ code: "INVALID_RESULT" });
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
    await using connection = await connectMcp(new McpServer({ name: "empty", version: "1" }));
    using listing = spyOn(connection.client, "listTools");
    const catalog = await createMcpCatalog(connection.client);

    expect(Object.keys(catalog.tools)).toEqual([]);
    expect(listing).not.toHaveBeenCalled();
  });

  test.each([0, 1.5, 2 ** 31])(
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

  test("releases discovery cancellation before invoking tools with a fresh signal", async () => {
    await using connection = await connectMcp(createMcpServer());
    const controller = new AbortController();
    using added = spyOn(controller.signal, "addEventListener");
    using removed = spyOn(controller.signal, "removeEventListener");

    const catalog = await createMcpCatalog(connection.client, { signal: controller.signal });

    const listener = added.mock.calls.find(([event]) => event === "abort")?.[1];
    expect(listener).toBeDefined();
    expect(removed).toHaveBeenCalledWith("abort", listener);
    controller.abort();
    const add = requireTool(catalog, "add");

    expect(await add({ a: 1, b: 2 }, context)).toEqual({
      ok: true,
      value: { content: [{ type: "text", text: '{"sum":3}' }], structuredContent: { sum: 3 } },
    });
  });

  test("cancellation stops discovery on a later page and keeps the client open", async () => {
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

describe("MCP invocation boundary", () => {
  test("rejects invalid arguments without rewriting them and forwards valid objects unchanged", async () => {
    const server = toolServer([
      {
        name: "read",
        inputSchema: {
          type: "object",
          properties: { count: { type: "number" }, optional: { type: "number", default: 3 } },
          required: ["count"],
          additionalProperties: false,
        },
      },
    ]);

    const received: unknown[] = [];
    server.server.setRequestHandler("tools/call", ({ params }) => {
      received.push(params.arguments);

      return { content: [], structuredContent: params.arguments };
    });
    await using connection = await connectMcp(server);
    const catalog = await createMcpCatalog(connection.client);
    const read = requireTool(catalog, "read");
    using invocation = spyOn(connection.client, "callTool");
    const numericString = { count: "2" };
    const extra = { count: 2, extra: true };

    expect(await read(numericString, context)).toEqual(
      ToolResult.failure('Invalid arguments for "read": /count must be number.'),
    );
    expect(await read(extra, context)).toEqual(
      ToolResult.failure('Invalid arguments for "read": / must NOT have additional properties.'),
    );
    expect(numericString).toEqual({ count: "2" });
    expect(extra).toEqual({ count: 2, extra: true });
    expect(invocation).not.toHaveBeenCalled();

    const args = { count: 2 };
    expect(await read(args, context)).toEqual({
      ok: true,
      value: { content: [], structuredContent: { count: 2 } },
    });
    expect(args).toEqual({ count: 2 });
    expect(received).toEqual([{ count: 2 }]);
    expect(invocation.mock.calls[0]?.[0].arguments).toBe(args);
  });

  test.each([null, [], 42])(
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

  test("preserves mixed content and error data while excluding top-level metadata and extensions", async () => {
    const server = toolServer([{ name: "read", inputSchema: { type: "object" } }]);

    const content: CallToolResult["content"] = [
      { type: "text", text: "Public explanation", _meta: { publicBlockMetadata: true } },
      { type: "image", data: "AA==", mimeType: "image/png" },
      { type: "resource_link", name: "record", uri: "test://record" },
    ];

    server.server.setRequestHandler("tools/call", () => ({
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

  test("returns stricter upstream validation failures as data", async () => {
    const server = createMcpServer();
    server.server.setRequestHandler("tools/list", () => ({
      tools: [{ name: "add", inputSchema: { type: "object" } }],
    }));
    await using connection = await connectMcp(server);
    const catalog = await createMcpCatalog(connection.client);

    const result = await requireTool(catalog, "add")({ a: "wrong", b: 3 }, context);

    expect(result).toMatchObject({ ok: true, value: { isError: true } });
    expect(JSON.stringify(result)).toContain("Input validation error");
  });

  test.each([
    { name: "null", value: null },
    { name: "false", value: false },
    { name: "array", value: [1, 2] },
  ])("preserves modern structured JSON $name", async ({ value: structuredContent }) => {
    const handler = createMcpHandler(() => {
      const server = toolServer([{ name: "read", inputSchema: { type: "object" } }]);
      // High-level callbacks synthesize text content; preserve the raw response under test.
      server.server.setRequestHandler("tools/call", () => ({
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
  });

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

    server.server.setRequestHandler("tools/call", () => ({
      content: [],
      structuredContent: { sum: "Private output details" },
    }));

    await using connection = await connectMcp(server);
    const catalog = await createMcpCatalog(connection.client);
    const sandbox = new CodeExecutor({ tools: catalog.tools });

    const report = await sandbox.execute("return await tools.read({});");

    expect(report).toEqual({
      result: { ok: false, error: { kind: "script", message: "Host tool failed." } },
      calls: [
        {
          callId: 1,
          name: "read",
          status: "completed",
          result: { ok: false, error: { message: "Host tool failed." } },
        },
      ],
    });
  });
});

describe("catalog input schemas", () => {
  test.each([
    [
      "draft-07",
      "https://json-schema.org/draft-07/schema",
      { ok: true, value: { content: [], structuredContent: { value: 1 } } },
    ],
    [
      "2020-12",
      "http://json-schema.org/draft/2020-12/schema#",
      { ok: false, error: { message: 'Invalid arguments for "read": /value must be <= 0.' } },
    ],
  ] satisfies [string, string, ToolResult][])(
    "preserves %s metadata and applies its reference semantics",
    async (_name, $schema, expected) => {
      const inputSchema = {
        type: "object" as const,
        $schema,
        definitions: { number: { type: "number" } },
        properties: { value: { $ref: "#/definitions/number", maximum: 0 } },
      };

      const server = toolServer([{ name: "read", inputSchema }]);
      server.server.setRequestHandler("tools/call", ({ params }) => ({
        content: [],
        structuredContent: params.arguments,
      }));
      await using connection = await connectMcp(server);
      const catalog = await createMcpCatalog(connection.client);

      expect(catalog.describe("read")?.inputSchema).toEqual(inputSchema);
      expect(await requireTool(catalog, "read")({ value: 1 }, context)).toEqual(expected);
    },
  );

  test.each([
    ["2020-12", "https://json-schema.org/draft/2020-12/schema"],
    ["draft-07", "http://json-schema.org/draft-07/schema#"],
  ])(
    "recovers discovery after an invalid %s schema reuses an identifier",
    async (_name, $schema) => {
      const server = toolServer();
      let minLength = -1;
      server.server.setRequestHandler("tools/list", () => ({
        tools: [
          {
            name: "read",
            inputSchema: {
              type: "object",
              $schema,
              $id: "https://example.invalid/input",
              properties: { id: { type: "string", minLength } },
              required: ["id"],
            },
          },
        ],
      }));
      server.server.setRequestHandler("tools/call", ({ params }) => ({
        content: [],
        structuredContent: params.arguments,
      }));
      await using connection = await connectMcp(server);

      const rejected = await rejectionOf(createMcpCatalog(connection.client));

      expect(rejected.reason).toBeInstanceOf(Error);
      if (!(rejected.reason instanceof Error)) throw new Error("Expected schema rejection");

      expect(rejected.reason.message).toBe(
        'Invalid input schema for tool "read": Input schema is invalid or has unresolved references.',
      );
      expect(rejected.reason.cause).toBeInstanceOf(Error);
      if (!(rejected.reason.cause instanceof Error)) throw new Error("Expected schema cause");

      expect(rejected.reason.cause.message).toStartWith("schema is invalid:");
      minLength = 1;
      const catalog = await createMcpCatalog(connection.client);
      const read = requireTool(catalog, "read");

      expect(await read({ id: "a" }, context)).toEqual({
        ok: true,
        value: { content: [], structuredContent: { id: "a" } },
      });
      expect(await read({ id: "" }, context)).toEqual(
        ToolResult.failure(
          'Invalid arguments for "read": /id must NOT have fewer than 1 characters.',
        ),
      );
    },
  );

  test.each([
    [
      "unsupported dialect",
      { type: "object", $schema: "https://json-schema.org/draft/2019-09/schema" },
      "Input schema must use JSON Schema 2020-12 or draft-07.",
    ],
    [
      "external reference",
      { type: "object", $ref: "https://example.invalid/schema" },
      "Input schema is invalid or has unresolved references.",
    ],
    [
      "asynchronous schema",
      { type: "object", $async: true },
      "Asynchronous input schemas are not supported.",
    ],
  ] satisfies [string, Tool["inputSchema"], string][])(
    "rejects an %s before exposing the catalog",
    async (_name, inputSchema, message) => {
      await using connection = await connectMcp(toolServer([{ name: "read", inputSchema }]));

      const rejected = await rejectionOf(createMcpCatalog(connection.client));

      expect(rejected.reason).toMatchObject({
        message: `Invalid input schema for tool "read": ${message}`,
      });
      expect(await connection.client.ping()).toEqual({});
    },
  );

  test("validates recursive records through local definitions and named anchors", async () => {
    const server = toolServer([
      {
        name: "read",
        inputSchema: {
          type: "object",
          $defs: {
            node: {
              $anchor: "node",
              type: "object",
              properties: { value: { type: "number" }, next: { $ref: "#node" } },
              required: ["value"],
            },
          },
          $ref: "#/$defs/node",
        },
      },
    ]);

    server.server.setRequestHandler("tools/call", ({ params }) => ({
      content: [],
      structuredContent: params.arguments,
    }));
    await using connection = await connectMcp(server);
    const read = requireTool(await createMcpCatalog(connection.client), "read");

    expect(await read({ value: 1, next: { value: "2" } }, context)).toEqual(
      ToolResult.failure('Invalid arguments for "read": /next/value must be number.'),
    );
    expect(await read({ value: 1, next: { value: 2 } }, context)).toEqual({
      ok: true,
      value: { content: [], structuredContent: { value: 1, next: { value: 2 } } },
    });
  });

  test("isolates schema identifiers across tools", async () => {
    const server = toolServer([
      {
        name: "numeric",
        inputSchema: {
          type: "object",
          $id: "https://example.invalid/input",
          $defs: { value: { $id: "value", type: "number" } },
          properties: { value: { $ref: "value" } },
        },
      },
      {
        name: "text",
        inputSchema: {
          type: "object",
          $id: "https://example.invalid/input",
          $defs: { value: { $id: "value", type: "string" } },
          properties: { value: { $ref: "value" } },
        },
      },
    ]);

    server.server.setRequestHandler("tools/call", ({ params }) => ({
      content: [],
      structuredContent: params.arguments,
    }));
    await using connection = await connectMcp(server);
    const catalog = await createMcpCatalog(connection.client);

    expect(await requireTool(catalog, "numeric")({ value: 1 }, context)).toEqual({
      ok: true,
      value: { content: [], structuredContent: { value: 1 } },
    });
    expect(await requireTool(catalog, "text")({ value: 1 }, context)).toEqual(
      ToolResult.failure('Invalid arguments for "text": /value must be string.'),
    );
    expect(await requireTool(catalog, "text")({ value: "one" }, context)).toEqual({
      ok: true,
      value: { content: [], structuredContent: { value: "one" } },
    });
  });

  test("validates known formats while allowing application annotations", async () => {
    const server = toolServer([
      {
        name: "read",
        inputSchema: {
          type: "object",
          properties: {
            email: { type: "string", format: "email" },
            id: { type: "string", format: "product-id" },
          },
        },
      },
    ]);

    server.server.setRequestHandler("tools/call", ({ params }) => ({
      content: [],
      structuredContent: params.arguments,
    }));
    await using connection = await connectMcp(server);
    const read = requireTool(await createMcpCatalog(connection.client), "read");

    expect(await read({ email: "invalid", id: "product-1" }, context)).toEqual(
      ToolResult.failure('Invalid arguments for "read": /email must match format "email".'),
    );
    expect(await read({ email: "user@example.com", id: "product-1" }, context)).toEqual({
      ok: true,
      value: { content: [], structuredContent: { email: "user@example.com", id: "product-1" } },
    });
  });

  test("requires JSON fields to be own properties", async () => {
    const server = toolServer([
      { name: "read", inputSchema: { type: "object", required: ["toString"] } },
    ]);

    server.server.setRequestHandler("tools/call", ({ params }) => ({
      content: [],
      structuredContent: params.arguments,
    }));
    await using connection = await connectMcp(server);
    const read = requireTool(await createMcpCatalog(connection.client), "read");

    expect(await read({}, context)).toEqual(
      ToolResult.failure(
        "Invalid arguments for \"read\": / must have required property 'toString'.",
      ),
    );
    expect(await read({ toString: "present" }, context)).toEqual({
      ok: true,
      value: { content: [], structuredContent: { toString: "present" } },
    });
  });
});
