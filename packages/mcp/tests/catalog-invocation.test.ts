import { describe, expect, spyOn, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, type CallToolResult } from "@modelcontextprotocol/server";
import { CodeExecutor, ToolResult } from "@cmg/codemode";
import { createMcpCatalog } from "@cmg/mcp";
import { createMcpServer } from "./fixtures/mcp-tools.ts";
import { connectMcp, requireTool, toolServer } from "./support/mcp.ts";

describe("createMcpCatalog invocation", () => {
  test("dispatches the original exact name and normalizes omitted arguments to an object", async () => {
    const server = toolServer([{ name: "__proto__", inputSchema: { type: "object" } }]);
    const received: unknown[] = [];
    server.server.setRequestHandler("tools/call", ({ params }) => {
      received.push(params);

      return { content: [], structuredContent: { name: params.name } };
    });
    await using connection = await connectMcp(server);
    const catalog = await createMcpCatalog(connection.client);
    const invoke = requireTool(catalog, "__proto__");

    const result = await invoke(undefined, { signal: new AbortController().signal });

    expect(result).toEqual({
      ok: true,
      value: { content: [], structuredContent: { name: "__proto__" } },
    });
    expect(received).toEqual([{ name: "__proto__", arguments: {} }]);
  });

  test.each([
    {
      name: "a numeric string without coercing it",
      args: { count: "2" },
      expected: 'Invalid arguments for "read": /count must be number.',
    },
    {
      name: "an extra field without removing it",
      args: { count: 2, extra: true },
      expected: 'Invalid arguments for "read": / must NOT have additional properties.',
    },
  ])("rejects $name before upstream dispatch", async ({ args, expected }) => {
    const server = toolServer([
      {
        name: "read",
        inputSchema: {
          type: "object",
          properties: { count: { type: "number" } },
          required: ["count"],
          additionalProperties: false,
        },
      },
    ]);

    await using connection = await connectMcp(server);
    const read = requireTool(await createMcpCatalog(connection.client), "read");
    const original = structuredClone(args);
    using invocation = spyOn(connection.client, "callTool");

    const result = await read(args, { signal: new AbortController().signal });

    expect(result).toEqual(ToolResult.failure(expected));
    expect(args).toEqual(original);
    expect(invocation).not.toHaveBeenCalled();
  });

  test("forwards valid objects unchanged without inserting schema defaults", async () => {
    const server = toolServer([
      {
        name: "read",
        inputSchema: {
          type: "object",
          properties: { count: { type: "number" }, optional: { type: "number", default: 3 } },
          required: ["count"],
        },
      },
    ]);

    const received: unknown[] = [];
    server.server.setRequestHandler("tools/call", ({ params }) => {
      received.push(params.arguments);

      return { content: [], structuredContent: params.arguments };
    });
    await using connection = await connectMcp(server);
    const read = requireTool(await createMcpCatalog(connection.client), "read");
    const args = { count: 2 };
    using invocation = spyOn(connection.client, "callTool");

    const result = await read(args, { signal: new AbortController().signal });

    expect(result).toEqual({ ok: true, value: { content: [], structuredContent: { count: 2 } } });
    expect(args).toEqual({ count: 2 });
    expect(received).toEqual([{ count: 2 }]);
    expect(invocation.mock.calls[0]?.[0].arguments).toBe(args);
  });

  test.each([
    ["null", null],
    ["an array", []],
    ["a number", 42],
  ])("rejects %s arguments before upstream dispatch", async (_name, args) => {
    await using connection = await connectMcp(createMcpServer());
    const add = requireTool(await createMcpCatalog(connection.client), "add");
    using invocation = spyOn(connection.client, "callTool");

    const result = await add(args, { signal: new AbortController().signal });

    expect(result).toEqual({
      ok: false,
      error: { message: "MCP tool arguments must be an object." },
    });
    expect(invocation).not.toHaveBeenCalled();
  });

  test("preserves public response fields while excluding top-level private extensions", async () => {
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
    const read = requireTool(await createMcpCatalog(connection.client), "read");

    const result = await read({}, { signal: new AbortController().signal });

    expect(result).toEqual({
      ok: true,
      value: { content, structuredContent: { detail: "public" }, isError: true },
    });
  });

  test("returns stricter upstream validation failures as ordinary data", async () => {
    const server = createMcpServer();
    server.server.setRequestHandler("tools/list", () => ({
      tools: [{ name: "add", inputSchema: { type: "object" } }],
    }));
    await using connection = await connectMcp(server);
    const add = requireTool(await createMcpCatalog(connection.client), "add");

    const result = await add({ a: "wrong", b: 3 }, { signal: new AbortController().signal });

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
    const read = requireTool(await createMcpCatalog(client), "read");

    const result = await read({}, { signal: new AbortController().signal });

    expect(result).toEqual({ ok: true, value: { content: [], structuredContent, isError: false } });
  });

  test("keeps SDK output-schema failures generic at the sandbox boundary", async () => {
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
        },
      ],
    });
  });
});
