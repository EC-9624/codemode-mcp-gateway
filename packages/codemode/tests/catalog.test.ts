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
    expect(catalog.search("adapter")).toEqual([]);
    expect(catalog.search("customerId")).toEqual([]);
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
    expect(catalog.search("customer invoices")).toEqual(matches);
  });

  test("ranks a rare intent term above common description terms", () => {
    const catalog = ToolCatalog.create({
      general: { description: "workspace record", execute: () => ToolResult.success() },
      events: { description: "webhook", execute: () => ToolResult.success() },
      alpha: { description: "workspace record", execute: () => ToolResult.success() },
      bravo: { description: "workspace record", execute: () => ToolResult.success() },
      charlie: { description: "workspace record", execute: () => ToolResult.success() },
      delta: { description: "workspace record", execute: () => ToolResult.success() },
    });

    expect(catalog.search("workspace record webhook")[0]?.name).toBe("events");
  });

  test("normalizes description length instead of favoring an earlier verbose match", () => {
    const catalog = ToolCatalog.create({
      verbose: {
        description: "Rotate credentials " + "unrelated details ".repeat(40),
        execute: () => ToolResult.success(),
      },
      concise: { description: "Rotate credentials", execute: () => ToolResult.success() },
    });

    expect(catalog.search("rotate credentials").map((tool) => tool.name)).toEqual([
      "concise",
      "verbose",
    ]);
  });

  test("uses term frequency when matching descriptions have the same length", () => {
    const catalog = ToolCatalog.create({
      first: { description: "rotate idle idle idle", execute: () => ToolResult.success() },
      second: { description: "rotate rotate idle idle", execute: () => ToolResult.success() },
    });

    expect(catalog.search("rotate").map((tool) => tool.name)).toEqual(["second", "first"]);
  });

  test("saturates repeated terms rather than letting keyword stuffing overwhelm a precise match", () => {
    const catalog = ToolCatalog.create({
      repeated: { description: "invoices ".repeat(100), execute: () => ToolResult.success() },
      precise: { description: "overdue invoices", execute: () => ToolResult.success() },
      other: { description: "invoices", execute: () => ToolResult.success() },
    });

    expect(catalog.search("overdue invoices")[0]?.name).toBe("precise");
  });

  test("keeps catalog insertion order when relevance scores tie", () => {
    const catalog = ToolCatalog.create({
      second: { description: "Read records", execute: () => ToolResult.success() },
      first: { description: "Read records", execute: () => ToolResult.success() },
    });

    expect(catalog.search("records").map((tool) => tool.name)).toEqual(["second", "first"]);
  });

  test("query casing does not change identifier tokenization or ranking", () => {
    const catalog = ToolCatalog.create({
      "crm.customerInvoicesArchive": {
        description: "Historical records " + "with details ".repeat(20),
        execute: () => ToolResult.success(),
      },
      "crm.customerInvoices": { description: "Read records", execute: () => ToolResult.success() },
    });

    expect(catalog.search("CustomerInvoices")).toEqual(catalog.search("CUSTOMERINVOICES"));
    expect(catalog.search("CustomerInvoices")).toEqual(catalog.search("customerinvoices"));
  });

  test.each([
    { query: "invoices", description: "Read an invoice" },
    { query: "deliveries", description: "Inspect delivery history" },
    { query: "policies", description: "Review a policy" },
    { query: "repositories", description: "Inspect a repository" },
    { query: "messages", description: "Read a message" },
    { query: "boxes", description: "Open a box" },
  ])("matches regular plural intent $query to a singular description", ({ query, description }) => {
    const catalog = ToolCatalog.create({
      inspect: { description, execute: () => ToolResult.success() },
    });

    expect(catalog.search(query).map((tool) => tool.name)).toEqual(["inspect"]);
  });

  test.each([
    { query: "news", description: "Announce a new release" },
    { query: "status", description: "Read statu data" },
    { query: "analysis", description: "Read analysi data" },
    { query: "access", description: "Read acces data" },
    { query: "series", description: "Read sery data" },
    { query: "species", description: "Read specy data" },
    { query: "physics", description: "Read physic data" },
    { query: "s3keys", description: "Read s3key data" },
  ])("does not manufacture a singular match for $query", ({ query, description }) => {
    const catalog = ToolCatalog.create({
      inspect: { description, execute: () => ToolResult.success() },
    });

    expect(catalog.search(query)).toEqual([]);
  });

  test("deduplicates plural aliases and explicit singular query tokens", () => {
    const catalog = ToolCatalog.create({
      read: { description: "Read an invoice", execute: () => ToolResult.success() },
      overdue: { description: "Find overdue invoices", execute: () => ToolResult.success() },
    });

    expect(catalog.search("invoices invoice INVOICES")).toEqual(catalog.search("invoices"));
  });

  test("retains exact plural evidence rather than replacing it with a singular token", () => {
    const catalog = ToolCatalog.create({
      single: { description: "Inspect invoice", execute: () => ToolResult.success() },
      multiple: { description: "Inspect invoices", execute: () => ToolResult.success() },
    });

    expect(catalog.search("invoices").map((tool) => tool.name)).toEqual(["multiple", "single"]);
  });

  test("ranks an exact qualified tool name above a longer name containing it", () => {
    const catalog = ToolCatalog.create({
      "crm.listInvoicesArchived": { description: "Read", execute: () => ToolResult.success() },
      "crm.listInvoices": {
        description: "Read customer invoices " + "with pagination ".repeat(10),
        execute: () => ToolResult.success(),
      },
    });

    expect(catalog.search(" CRM.listInvoices ")[0]?.name).toBe("crm.listInvoices");
  });

  test.each([
    { query: "list-invoices", name: "crm.listInvoices", description: "Read billing data" },
    { query: "http-response", name: "readHTTPResponse", description: "Inspect network data" },
    { query: "search_pages", name: "notion.search-pages", description: "Find content" },
    { query: "café", name: "places.lookup", description: "Find a cafe\u0301 nearby" },
    { query: "mail", name: "sendEmail", description: "Send a message" },
    { query: "chron", name: "inspect", description: "Check synchronization state" },
    { query: ".", name: "crm.read", description: "Read data" },
    { query: "資料", name: "資料検索", description: "ドキュメントを探す" },
    { query: "🔥", name: "🔥", description: "" },
    { query: "\u0301", name: "accent", description: "cafe\u0301" },
  ])(
    "finds $name for $query without relying on whitespace-only tokenization",
    ({ query, name, description }) => {
      const catalog = ToolCatalog.create({
        [name]: { description, execute: () => ToolResult.success() },
      });

      expect(catalog.search(query).map((tool) => tool.name)).toEqual([name]);
    },
  );

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
    expect(catalog.search("original").map((tool) => tool.name)).toEqual(["read"]);
    expect(catalog.search("changed")).toEqual([]);
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
