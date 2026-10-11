import { describe, expect, test } from "bun:test";
import { execute, ToolResult } from "../src/sandbox";
import { createDiscoveryTools, ToolCatalog } from "../src/tool-catalog";

describe("host tool catalog", () => {
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

  test("snapshots callback bindings and descriptive fields at creation", async () => {
    const definition = {
      description: "Original description",
      execute: () => ToolResult.success(1),
    };

    const definitions = { read: definition };
    const catalog = ToolCatalog.create(definitions);
    definition.description = "Changed description";
    definition.execute = () => ToolResult.success(2);
    expect(catalog.describe("read")?.description).toBe("Original description");
    expect(await execute("return await tools.read();", catalog.tools)).toEqual({
      ok: true,
      value: 1,
    });
  });

  test("only describes own entries and preserves tool names exactly", async () => {
    const catalog = ToolCatalog.create(
      Object.fromEntries(
        ["billing.list-invoices", "__proto__", "constructor"].map((name) => [
          name,
          { description: name, execute: () => ToolResult.success(name) },
        ]),
      ),
    );

    expect(catalog.describe("toString")).toBeUndefined();
    expect(catalog.describe("missing")).toBeUndefined();
    expect(
      await execute(
        `return await Promise.all([
      tools["billing.list-invoices"](), tools.__proto__(), tools.constructor(),
    ]);`,
        catalog.tools,
      ),
    ).toEqual({ ok: true, value: ["billing.list-invoices", "__proto__", "constructor"] });
  });
});

describe("catalog discovery through the sandbox", () => {
  test("discovers a tool, reads its schema, and calls its existing named wrapper", async () => {
    let calls = 0;

    const catalog = ToolCatalog.create({
      "billing.listInvoices": {
        description: "List customer invoices",
        inputSchema: {
          type: "object",
          required: ["customerId"],
          properties: { customerId: { type: "string" } },
        },
        execute: (args) => {
          if (
            typeof args !== "object" ||
            args === null ||
            !("customerId" in args) ||
            typeof args.customerId !== "string"
          ) {
            return ToolResult.failure("customerId must be a string.");
          }

          calls += 1;

          return ToolResult.success([{ customerId: args.customerId, total: 42 }]);
        },
      },
    });

    const discovery = createDiscoveryTools(catalog);
    expect(
      await execute(
        `
      const matches = await tools.searchTools({ query: "customer invoices" });
      const name = matches[0].name;
      const description = await tools.describeTool({ name });
      return {
        required: description.inputSchema.required,
        invoices: await tools[name]({ customerId: "123" }),
      };
    `,
        {
          ...catalog.tools,
          searchTools: discovery.searchTools,
          describeTool: discovery.describeTool,
        },
      ),
    ).toEqual({
      ok: true,
      value: { required: ["customerId"], invoices: [{ customerId: "123", total: 42 }] },
    });
    expect(calls).toBe(1);
    expect(
      await execute(
        'return await tools["billing.listInvoices"]({ customerId: 123 });',
        catalog.tools,
      ),
    ).toEqual({
      ok: false,
      error: { kind: "script", message: "customerId must be a string." },
    });
    expect(calls).toBe(1);
  });

  test("reports invalid discovery requests as public tool failures", async () => {
    const discovery = createDiscoveryTools(ToolCatalog.create({}));
    for (const args of [undefined, null, "query", {}, { query: 42 }, { query: " " }]) {
      expect(discovery.searchTools(args)).toEqual(
        ToolResult.failure("searchTools expects a non-empty query string in { query }."),
      );
    }

    for (const args of [undefined, null, "name", {}, { name: 42 }]) {
      expect(discovery.describeTool(args)).toEqual(
        ToolResult.failure("describeTool expects a tool name string in { name }."),
      );
    }

    expect(
      await execute(
        'try { await tools.describeTool({ name: "missing" }); } catch (error) { return error.message; }',
        discovery,
      ),
    ).toEqual({
      ok: true,
      value: "Tool not found in this catalog.",
    });
    expect(
      await execute('return await tools.searchTools({ query: "unmatched" });', discovery),
    ).toEqual({ ok: true, value: [] });
  });

  test("lets the app choose discovery names without replacing a catalog tool", async () => {
    const catalog = ToolCatalog.create({
      searchTools: { description: "Application tool", execute: () => ToolResult.success(42) },
    });

    const discovery = createDiscoveryTools(catalog);
    expect(
      await execute(
        `return {
      value: await tools.searchTools(),
      names: (await tools.findTools({ query: "application" })).map(tool => tool.name),
    };`,
        { ...catalog.tools, findTools: discovery.searchTools },
      ),
    ).toEqual({ ok: true, value: { value: 42, names: ["searchTools"] } });
  });

  test("keeps catalogs and discovery results separate across concurrent executions", async () => {
    const results = await Promise.all(
      ["first", "second"].map((name) => {
        const catalog = ToolCatalog.create({
          [name]: { description: "Read value", execute: () => ToolResult.success(name) },
        });

        const discovery = createDiscoveryTools(catalog);

        return execute(
          `const matches = await tools.searchTools({ query: "value" });
        return await tools[matches[0].name]();`,
          { ...catalog.tools, searchTools: discovery.searchTools },
        );
      }),
    );

    expect(results).toEqual([
      { ok: true, value: "first" },
      { ok: true, value: "second" },
    ]);
  });
});
