import { describe, expect, test } from "bun:test";
import { ToolResult, createDiscoveryTools, ToolCatalog } from "../../src/codemode";

describe("ToolCatalog", () => {
  test("describes tools without invoking or exposing their implementations", () => {
    let calls = 0;

    const definition = {
      description: "List customer invoices",
      inputSchema: { type: "object", properties: { customerId: { type: "string" } } },
      privateDetails: "Private adapter configuration",
      execute: () => {
        calls += 1;

        return ToolResult.success([]);
      },
    };

    const catalog = ToolCatalog.create({ listInvoices: definition });

    const expected = {
      name: "listInvoices",
      description: "List customer invoices",
      inputSchema: definition.inputSchema,
    };

    expect(catalog.describe("listInvoices")).toEqual(expected);
    expect(catalog.search("invoices")).toEqual([expected]);
    expect(calls).toBe(0);
  });

  test("ranks case-insensitive name and description matches by distinct query terms", () => {
    const catalog = ToolCatalog.create({
      listInvoices: { description: "List invoices", execute: () => ToolResult.success() },
      customerInvoices: {
        description: "Read customer invoices",
        execute: () => ToolResult.success(),
      },
      customerProfiles: {
        description: "Read customer profiles",
        execute: () => ToolResult.success(),
      },
      sendEmail: { description: "Send a message", execute: () => ToolResult.success() },
    });

    expect(catalog.search("  CUSTOMER invoices customer ").map((tool) => tool.name)).toEqual([
      "customerInvoices",
      "listInvoices",
      "customerProfiles",
    ]);
    expect(catalog.search("sendEmail").map((tool) => tool.name)).toEqual(["sendEmail"]);
    expect(catalog.search(" ")).toEqual([]);
    expect(catalog.search("unmatched")).toEqual([]);
  });

  test("preserves absent and boolean schema metadata", () => {
    const catalog = ToolCatalog.create({
      withoutSchema: { description: "No schema", execute: () => ToolResult.success() },
      unrestricted: {
        description: "Any input",
        inputSchema: true,
        execute: () => ToolResult.success(),
      },
      impossible: {
        description: "No input permitted",
        inputSchema: false,
        execute: () => ToolResult.success(),
      },
    });

    expect(catalog.describe("withoutSchema")).toEqual({
      name: "withoutSchema",
      description: "No schema",
    });
    expect(catalog.describe("unrestricted")?.inputSchema).toBe(true);
    expect(catalog.describe("impossible")?.inputSchema).toBe(false);
  });
});

describe("discovery input validation", () => {
  test.each([
    ["absent", undefined],
    ["null", null],
    ["string", "query"],
    ["missing query", {}],
    ["numeric query", { query: 42 }],
    ["blank query", { query: " " }],
  ] as const)("rejects %s search arguments", (_name, args) => {
    const discovery = createDiscoveryTools(ToolCatalog.create({}));

    const result = discovery.searchTools(args);

    expect(result).toEqual(
      ToolResult.failure("searchTools expects a non-empty query string in { query }."),
    );
  });

  test.each([
    ["absent", undefined],
    ["null", null],
    ["string", "name"],
    ["missing name", {}],
    ["numeric name", { name: 42 }],
  ] as const)("rejects %s description arguments", (_name, args) => {
    const discovery = createDiscoveryTools(ToolCatalog.create({}));

    const result = discovery.describeTool(args);

    expect(result).toEqual(
      ToolResult.failure("describeTool expects a tool name string in { name }."),
    );
  });
});
