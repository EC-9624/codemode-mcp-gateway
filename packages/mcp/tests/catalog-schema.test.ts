import { describe, expect, test } from "bun:test";
import { type Tool } from "@modelcontextprotocol/client";
import { ToolResult } from "@cmg/codemode";
import { createMcpCatalog } from "@cmg/mcp";
import { connectMcp, requireTool, toolServer } from "./support/mcp.ts";
import { rejectionOf } from "./support/rejection.ts";

describe("createMcpCatalog input schemas", () => {
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
      const read = requireTool(catalog, "read");

      const result = await read({ value: 1 }, { signal: new AbortController().signal });

      expect(catalog.describe("read")?.inputSchema).toEqual(inputSchema);
      expect(result).toEqual(expected);
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
      minLength = 1;
      const read = requireTool(await createMcpCatalog(connection.client), "read");
      const context = { signal: new AbortController().signal };
      const valid = await read({ id: "a" }, context);
      const invalid = await read({ id: "" }, context);

      expect(rejected.reason).toBeInstanceOf(Error);
      if (!(rejected.reason instanceof Error)) throw new Error("Expected schema rejection");

      expect(rejected.reason.message).toBe(
        'Invalid input schema for tool "read": Input schema is invalid or has unresolved references.',
      );
      expect(rejected.reason.cause).toBeInstanceOf(Error);
      if (!(rejected.reason.cause instanceof Error)) throw new Error("Expected schema cause");

      expect(rejected.reason.cause.message).toStartWith("schema is invalid:");
      expect(valid).toEqual({ ok: true, value: { content: [], structuredContent: { id: "a" } } });
      expect(invalid).toEqual(
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

  test.each([
    {
      name: "valid recursive records",
      args: { value: 1, next: { value: 2 } },
      expected: {
        ok: true,
        value: { content: [], structuredContent: { value: 1, next: { value: 2 } } },
      },
    },
    {
      name: "an invalid nested value",
      args: { value: 1, next: { value: "2" } },
      expected: {
        ok: false,
        error: { message: 'Invalid arguments for "read": /next/value must be number.' },
      },
    },
  ])("validates $name through local definitions and anchors", async ({ args, expected }) => {
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

    const result = await read(args, { signal: new AbortController().signal });

    expect(result).toEqual(expected);
  });

  test("isolates identical schema identifiers across tools", async () => {
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
    const context = { signal: new AbortController().signal };

    const numeric = await requireTool(catalog, "numeric")({ value: 1 }, context);
    const invalidText = await requireTool(catalog, "text")({ value: 1 }, context);
    const text = await requireTool(catalog, "text")({ value: "one" }, context);

    expect(numeric).toEqual({ ok: true, value: { content: [], structuredContent: { value: 1 } } });
    expect(invalidText).toEqual(
      ToolResult.failure('Invalid arguments for "text": /value must be string.'),
    );
    expect(text).toEqual({ ok: true, value: { content: [], structuredContent: { value: "one" } } });
  });

  test.each([
    {
      name: "a known invalid email format",
      args: { email: "invalid", id: "product-1" },
      expected: {
        ok: false,
        error: { message: 'Invalid arguments for "read": /email must match format "email".' },
      },
    },
    {
      name: "a valid email with an application format",
      args: { email: "user@example.com", id: "product-1" },
      expected: {
        ok: true,
        value: { content: [], structuredContent: { email: "user@example.com", id: "product-1" } },
      },
    },
  ])("validates $name", async ({ args, expected }) => {
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

    const result = await read(args, { signal: new AbortController().signal });

    expect(result).toEqual(expected);
  });

  const requiredProperties: {
    name: string;
    args: Record<string, unknown>;
    expected: ToolResult;
  }[] = [
    {
      name: "rejects an inherited required property",
      args: {},
      expected: {
        ok: false,
        error: {
          message: "Invalid arguments for \"read\": / must have required property 'toString'.",
        },
      },
    },
    {
      name: "accepts an own required property",
      args: { toString: "present" },
      expected: { ok: true, value: { content: [], structuredContent: { toString: "present" } } },
    },
  ];

  test.each(requiredProperties)("$name", async ({ args, expected }) => {
    const server = toolServer([
      { name: "read", inputSchema: { type: "object", required: ["toString"] } },
    ]);

    server.server.setRequestHandler("tools/call", ({ params }) => ({
      content: [],
      structuredContent: params.arguments,
    }));
    await using connection = await connectMcp(server);
    const read = requireTool(await createMcpCatalog(connection.client), "read");

    const result = await read(args, { signal: new AbortController().signal });

    expect(result).toEqual(expected);
  });
});
