import { describe, expect, test } from "bun:test";
import { createDiscoveryTools, CodemodeSandbox, ToolCatalog, ToolResult } from "../../src/codemode";

describe("host tool catalog", () => {
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
    expect(
      (await new CodemodeSandbox({ tools: catalog.tools }).execute("return await tools.read();"))
        .result,
    ).toEqual({
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
      (
        await new CodemodeSandbox({ tools: catalog.tools }).execute(
          `return await Promise.all([
      tools["billing.list-invoices"](), tools.__proto__(), tools.constructor(),
    ]);`,
        )
      ).result,
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
      (
        await new CodemodeSandbox({
          tools: {
            ...catalog.tools,
            searchTools: discovery.searchTools,
            describeTool: discovery.describeTool,
          },
        }).execute(
          `
      const matches = await tools.searchTools({ query: "customer invoices" });
      const name = matches[0].name;
      const description = await tools.describeTool({ name });
      return {
        required: description.inputSchema.required,
        invoices: await tools[name]({ customerId: "123" }),
      };
    `,
        )
      ).result,
    ).toEqual({
      ok: true,
      value: { required: ["customerId"], invoices: [{ customerId: "123", total: 42 }] },
    });
    expect(calls).toBe(1);
    expect(
      (
        await new CodemodeSandbox({ tools: catalog.tools }).execute(
          'return await tools["billing.listInvoices"]({ customerId: 123 });',
        )
      ).result,
    ).toEqual({
      ok: false,
      error: { kind: "script", message: "customerId must be a string." },
    });
    expect(calls).toBe(1);
  });

  test("reports missing tools and unmatched searches through discovery", async () => {
    const discovery = createDiscoveryTools(ToolCatalog.create({}));

    expect(
      (
        await new CodemodeSandbox({ tools: discovery }).execute(
          'try { await tools.describeTool({ name: "missing" }); } catch (error) { return error.message; }',
        )
      ).result,
    ).toEqual({
      ok: true,
      value: "Tool not found in this catalog.",
    });
    expect(
      (
        await new CodemodeSandbox({ tools: discovery }).execute(
          'return await tools.searchTools({ query: "unmatched" });',
        )
      ).result,
    ).toEqual({ ok: true, value: [] });
  });

  test("lets the app choose discovery names without replacing a catalog tool", async () => {
    const catalog = ToolCatalog.create({
      searchTools: { description: "Application tool", execute: () => ToolResult.success(42) },
    });

    const discovery = createDiscoveryTools(catalog);
    expect(
      (
        await new CodemodeSandbox({
          tools: { ...catalog.tools, findTools: discovery.searchTools },
        }).execute(
          `return {
      value: await tools.searchTools(),
      names: (await tools.findTools({ query: "application" })).map(tool => tool.name),
    };`,
        )
      ).result,
    ).toEqual({ ok: true, value: { value: 42, names: ["searchTools"] } });
  });

  test("keeps catalogs and discovery results separate across concurrent executions", async () => {
    const results = await Promise.all(
      ["first", "second"].map((name) => {
        const catalog = ToolCatalog.create({
          [name]: { description: "Read value", execute: () => ToolResult.success(name) },
        });

        const discovery = createDiscoveryTools(catalog);

        return new CodemodeSandbox({
          tools: { ...catalog.tools, searchTools: discovery.searchTools },
        }).execute(
          `const matches = await tools.searchTools({ query: "value" });
        return await tools[matches[0].name]();`,
        );
      }),
    );

    expect(results.map((report) => report.result)).toEqual([
      { ok: true, value: "first" },
      { ok: true, value: "second" },
    ]);
  });
});
