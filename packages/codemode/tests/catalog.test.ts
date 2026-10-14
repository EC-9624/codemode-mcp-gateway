import { describe, expect, test } from "bun:test";
import { CodeExecutor, ToolResult, createDiscoveryTools, ToolCatalog } from "@cmg/codemode";

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

  test("snapshots callbacks and descriptive fields without invoking them", async () => {
    const definition = {
      description: "Original description",
      execute: () => ToolResult.success(1),
    };

    const catalog = ToolCatalog.create({ read: definition });
    definition.description = "Changed description";
    definition.execute = () => ToolResult.success(2);

    expect(catalog.describe("read")?.description).toBe("Original description");
    expect(await catalog.tools.read?.(undefined, { signal: new AbortController().signal })).toEqual(
      ToolResult.success(1),
    );
  });

  test("keeps separate catalogs and ignores inherited definition entries", () => {
    const first = ToolCatalog.create({
      first: { description: "Read value", execute: () => ToolResult.success(1) },
    });

    const definitions = {
      second: { description: "Read value", execute: () => ToolResult.success(2) },
    };

    Object.setPrototypeOf(definitions, {
      inherited: { description: "Read value", execute: () => ToolResult.success(3) },
    });
    const second = ToolCatalog.create(definitions);

    expect(first.search("value").map((tool) => tool.name)).toEqual(["first"]);
    expect(second.search("value").map((tool) => tool.name)).toEqual(["second"]);
    expect(second.describe("inherited")).toBeUndefined();
    expect(second.describe("toString")).toBeUndefined();
    expect(Object.keys(second.tools)).toEqual(["second"]);
  });
});

describe("discovery input validation", () => {
  test.each([
    ["null", null],
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
    ["null", null],
    ["numeric name", { name: 42 }],
  ] as const)("rejects %s description arguments", (_name, args) => {
    const discovery = createDiscoveryTools(ToolCatalog.create({}));

    const result = discovery.describeTool(args);

    expect(result).toEqual(
      ToolResult.failure("describeTool expects a tool name string in { name }."),
    );
  });
});

describe("catalog discovery", () => {
  test("discovers descriptive schema metadata and invokes the selected named tool", async () => {
    const received: unknown[] = [];

    const catalog = ToolCatalog.create({
      "billing.listInvoices": {
        description: "List customer invoices",
        inputSchema: {
          type: "object",
          required: ["customerId"],
          properties: { customerId: { type: "string" } },
        },
        execute: (args) => {
          received.push(args);

          return ToolResult.success([{ id: "invoice-1", total: 42 }]);
        },
      },
    });

    const sandbox = new CodeExecutor({
      tools: { ...catalog.tools, ...createDiscoveryTools(catalog) },
    });

    const report = await sandbox.execute(`
      const matches = await tools.searchTools({ query: "customer invoices" });
      const description = await tools.describeTool({ name: matches[0].name });
      return {
        required: description.inputSchema.required,
        invoices: await tools[matches[0].name]({ customerId: 123 }),
      };
    `);

    // Manually supplied JSON Schema describes input; the callback owns validation.
    expect(received).toEqual([{ customerId: 123 }]);
    expect(report.result).toEqual({
      ok: true,
      value: { required: ["customerId"], invoices: [{ id: "invoice-1", total: 42 }] },
    });
    expect(report.calls.map((call) => call.name)).toEqual([
      "searchTools",
      "describeTool",
      "billing.listInvoices",
    ]);
  });

  test("reports unknown names and unmatched queries without invoking tools", () => {
    const discovery = createDiscoveryTools(ToolCatalog.create({}));

    expect(discovery.describeTool({ name: "missing" })).toEqual(
      ToolResult.failure("Tool not found in this catalog."),
    );
    expect(discovery.searchTools({ query: "unmatched" })).toEqual(ToolResult.success([]));
  });

  test("lets the app choose discovery names without replacing a catalog tool", async () => {
    const catalog = ToolCatalog.create({
      searchTools: { description: "Application tool", execute: () => ToolResult.success(42) },
    });

    const discovery = createDiscoveryTools(catalog);

    const sandbox = new CodeExecutor({
      tools: { ...catalog.tools, findTools: discovery.searchTools },
    });

    const report = await sandbox.execute(`return {
      value: await tools.searchTools(),
      names: (await tools.findTools({ query: "application" })).map(tool => tool.name),
    };`);

    expect(report.result).toEqual({ ok: true, value: { value: 42, names: ["searchTools"] } });
  });
});
