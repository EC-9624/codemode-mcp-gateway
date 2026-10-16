import { describe, expect, expectTypeOf, test } from "bun:test";
import {
  CodeExecutor,
  ToolResult,
  createDiscoveryTools,
  ToolCatalog,
  type ToolSearchPage,
} from "@codemode-mcp-gateway/codemode";

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

  test("ranks distinct case-insensitive query terms with stable ties", () => {
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

    const matches = catalog.search("  CUSTOMER invoices customer ");

    expect(matches.map((tool) => tool.name)).toEqual([
      "customerInvoices",
      "listInvoices",
      "customerProfiles",
    ]);
  });

  test("matches a tool name when its description does not contain the query", () => {
    const catalog = ToolCatalog.create({
      sendEmail: { description: "Send a message", execute: () => ToolResult.success() },
    });

    const matches = catalog.search("sendEmail");

    expect(matches.map((tool) => tool.name)).toEqual(["sendEmail"]);
  });

  test("prioritizes action names over unrelated descriptions mentioning all query terms", () => {
    const catalog = ToolCatalog.create({
      "notion-update": {
        description: "Update Notion pages after search and fetch",
        execute: () => ToolResult.success(),
      },
      "notion-search": { description: "Find pages", execute: () => ToolResult.success() },
      "notion-fetch": { description: "Read a page", execute: () => ToolResult.success() },
      archive: {
        description: "Search and fetch Notion archives",
        execute: () => ToolResult.success(),
      },
    });

    const matches = catalog.search("NOTION search fetch");

    expect(matches.map((tool) => tool.name)).toEqual([
      "notion-search",
      "notion-fetch",
      "notion-update",
      "archive",
    ]);
  });

  test.each([
    ["blank", " "],
    ["unmatched", "unmatched"],
  ])("returns no matches for a %s query", (_name, query) => {
    const catalog = ToolCatalog.create({
      read: { description: "Read a record", execute: () => ToolResult.success() },
    });

    const matches = catalog.search(query);

    expect(matches).toEqual([]);
  });

  test("keeps schema metadata as the caller's read-only reference", () => {
    const inputSchema = Object.freeze({ type: "number" });

    const catalog = ToolCatalog.create({
      read: { description: "Read a number", inputSchema, execute: () => ToolResult.success() },
    });

    const description = catalog.describe("read");

    expect(description?.inputSchema).toBe(inputSchema);
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

  test("keeps independent catalog entries separate", () => {
    const first = ToolCatalog.create({
      first: { description: "Read value", execute: () => ToolResult.success(1) },
    });

    const second = ToolCatalog.create({
      second: { description: "Read value", execute: () => ToolResult.success(2) },
    });

    const firstMatches = first.search("value");
    const secondMatches = second.search("value");

    expect(firstMatches.map((tool) => tool.name)).toEqual(["first"]);
    expect(secondMatches.map((tool) => tool.name)).toEqual(["second"]);
  });

  test("ignores inherited entries in the supplied definitions", () => {
    const definitions = {
      second: { description: "Read value", execute: () => ToolResult.success(2) },
    };

    Object.setPrototypeOf(definitions, {
      inherited: { description: "Read value", execute: () => ToolResult.success(3) },
    });
    const second = ToolCatalog.create(definitions);

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
    { name: "zero limit", field: "limit", value: 0 },
    { name: "negative limit", field: "limit", value: -1 },
    { name: "fractional limit", field: "limit", value: 1.5 },
    { name: "null limit", field: "limit", value: null },
    { name: "string limit", field: "limit", value: "5" },
    { name: "infinite limit", field: "limit", value: Infinity },
    { name: "unsafe limit", field: "limit", value: Number.MAX_SAFE_INTEGER + 1 },
    { name: "negative offset", field: "offset", value: -1 },
    { name: "fractional offset", field: "offset", value: 0.5 },
    { name: "null offset", field: "offset", value: null },
    { name: "string offset", field: "offset", value: "0" },
    { name: "NaN offset", field: "offset", value: NaN },
    { name: "unsafe offset", field: "offset", value: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects a $name", ({ field, value }) => {
    const discovery = createDiscoveryTools(ToolCatalog.create({}));

    const result = discovery.searchTools({ query: "records", [field]: value });

    expect(result).toEqual(
      ToolResult.failure(
        field === "limit"
          ? "searchTools limit must be a positive safe integer."
          : "searchTools offset must be a non-negative safe integer.",
      ),
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
  test("pages all matches with five summaries by default and explicit completion", async () => {
    const catalog = ToolCatalog.create(
      Object.fromEntries(
        ["search", "fetch", "list", "count", "export", "status", "delete"].map((name) => [
          `records.${name}`,
          {
            description: `${name} records`,
            inputSchema: { type: "object" },
            execute: () => ToolResult.success(),
          },
        ]),
      ),
    );

    const sandbox = new CodeExecutor({ tools: createDiscoveryTools(catalog) });

    const first = await sandbox.execute('return await tools.searchTools({ query: "records" });');

    const last = await sandbox.execute(
      'return await tools.searchTools({ query: "records", offset: 5 });',
    );

    const beyond = await sandbox.execute(
      'return await tools.searchTools({ query: "records", offset: 99 });',
    );

    const custom = await sandbox.execute(
      'return await tools.searchTools({ query: "records", offset: 1, limit: 2 });',
    );

    const larger = await sandbox.execute(`
      const page = await tools.searchTools({ query: "records", limit: 10 });
      return { count: page.tools.length, total: page.total, nextOffset: page.nextOffset };
    `);

    expect(first.result).toEqual({
      ok: true,
      value: {
        tools: [
          { name: "records.search", description: "search records" },
          { name: "records.fetch", description: "fetch records" },
          { name: "records.list", description: "list records" },
          { name: "records.count", description: "count records" },
          { name: "records.export", description: "export records" },
        ],
        total: 7,
        nextOffset: 5,
      },
    });
    expect(last.result).toEqual({
      ok: true,
      value: {
        tools: [
          { name: "records.status", description: "status records" },
          { name: "records.delete", description: "delete records" },
        ],
        total: 7,
        nextOffset: null,
      },
    });
    expect(beyond.result).toEqual({ ok: true, value: { tools: [], total: 7, nextOffset: null } });
    expect(custom.result).toEqual({
      ok: true,
      value: {
        tools: [
          { name: "records.fetch", description: "fetch records" },
          { name: "records.list", description: "list records" },
        ],
        total: 7,
        nextOffset: 3,
      },
    });
    expect(larger.result).toEqual({ ok: true, value: { count: 7, total: 7, nextOffset: null } });
  });

  test("keeps search small with large schemas while selected descriptions remain complete", async () => {
    let invoked = 0;
    const description = "  Search records.\n  " + "x".repeat(200) + " ";

    const catalog = ToolCatalog.create({
      "records.search": {
        description,
        inputSchema: { type: "object", description: "x".repeat(300_000) + "schema end" },
        execute: () => {
          invoked++;

          return ToolResult.success();
        },
      },
    });

    const sandbox = new CodeExecutor({
      tools: createDiscoveryTools(catalog),
      maxOutputBytes: 1024,
    });

    const report = await sandbox.execute(`
      const page = await tools.searchTools({ query: "records" });
      const selected = await tools.describeTool({ name: page.tools[0].name });
      return { page, description: selected.description, schemaLength: selected.inputSchema.description.length,
        schemaEnd: selected.inputSchema.description.endsWith("schema end") };
    `);

    expect(report.result).toEqual({
      ok: true,
      value: {
        page: {
          tools: [
            { name: "records.search", description: "Search records. " + "x".repeat(183) + "…" },
          ],
          total: 1,
          nextOffset: null,
        },
        description,
        schemaLength: 300_010,
        schemaEnd: true,
      },
    });
    expect(invoked).toBe(0);
  });

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
      const description = await tools.describeTool({ name: matches.tools[0].name });
      return {
        required: description.inputSchema.required,
        invoices: await tools[matches.tools[0].name]({ customerId: 123 }),
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

  test("returns a public failure when describing an unknown tool", () => {
    const discovery = createDiscoveryTools(ToolCatalog.create({}));

    const result = discovery.describeTool({ name: "missing" });

    expect(result).toEqual(ToolResult.failure("Tool not found in this catalog."));
  });

  test("returns an empty successful result when discovery has no matches", () => {
    const discovery = createDiscoveryTools(ToolCatalog.create({}));

    const result = discovery.searchTools({ query: "unmatched" });

    expectTypeOf<Extract<typeof result, { ok: true }>["value"]>().toMatchTypeOf<ToolSearchPage>();
    expect(result).toEqual({ ok: true, value: { tools: [], total: 0, nextOffset: null } });
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
      names: (await tools.findTools({ query: "application" })).tools.map(tool => tool.name),
    };`);

    expect(report.result).toEqual({ ok: true, value: { value: 42, names: ["searchTools"] } });
  });
});
