import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Configuration, Gateway, type CredentialOptions } from "codemode-mcp-gateway";
import { memoryCredentials, oauthFixture } from "./support/oauth.ts";
import { connect } from "./support/gateway.ts";
import { responseText, responseValue } from "./support/output.ts";

const localCommand = [
  process.execPath,
  fileURLToPath(new URL("../../../examples/shared/mcp-server.ts", import.meta.url)),
];

describe("gateway discovery and partial availability", () => {
  test("lists only current upstream metadata and availability without making upstream requests", async () => {
    await using upstream = await oauthFixture();

    await using gateway = new Gateway(
      Configuration.parse({
        mcp: {
          servers: {
            notes: {
              type: "remote",
              url: upstream.url,
              headers: { Authorization: "Bearer access-0" },
            },
            paused: { type: "local", command: ["unused"], disabled: true },
            broken: { type: "local", command: ["nonexistent-tools-upstream"] },
          },
        },
      }),
      ".",
    );

    await gateway.start();
    const requests = upstream.requests.length;

    const listing = gateway.listTools();

    expect(listing.tools).toEqual([
      { server: "notes", name: "notes.add", description: "Add two numbers" },
    ]);
    expect(listing.servers).toMatchObject([
      { name: "notes", state: "connected", toolCount: 1 },
      { name: "paused", state: "disabled", toolCount: 0 },
      { name: "broken", state: "failed", toolCount: 0 },
    ]);
    expect(upstream.requests).toHaveLength(requests);
  });

  test("the description matches server-filtered discovery capabilities", async () => {
    await using gateway = new Gateway(
      Configuration.parse({ mcp: { servers: { math: { type: "local", command: localCommand } } } }),
      ".",
    );

    await gateway.start();
    await using agent = await connect(gateway.createServer());

    const listing = await agent.client.listTools();
    const description = listing.tools[0]?.description;

    const response = await agent.client.callTool({
      name: "execute",
      arguments: {
        code: 'return await tools.searchTools({ query: "add", server: "math" });',
      },
    });

    expect(description).toContain("## Availability");
    expect(description).toContain('Tool names are qualified as "server.original-name".');
    expect(description).toContain("use a new execution");
    expect(responseValue(response)).toMatchObject({
      tools: [{ name: "math.add" }],
      servers: [{ name: "math", state: "connected" }],
    });
  });

  test.each(["searchTools", "describeTool"])(
    "qualifies an upstream %s tool without replacing the discovery helper",
    async (name) => {
      await using upstream = await oauthFixture({
        mcp: async (request) => {
          if (request.method !== "POST") return;

          const body: unknown = await request.clone().json();
          if (typeof body !== "object" || body === null || !("method" in body) || !("id" in body))
            return;

          if (body.method === "tools/list")
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: { tools: [{ name, inputSchema: { type: "object" } }] },
            });

          if (body.method === "tools/call")
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: { content: [], structuredContent: { invoked: name } },
            });
        },
      });

      await using gateway = new Gateway(
        Configuration.parse({
          mcp: {
            servers: {
              notes: {
                type: "remote",
                url: upstream.url,
                headers: { Authorization: "Bearer access-0" },
              },
            },
          },
        }),
        ".",
      );

      await gateway.start();
      await using agent = await connect(gateway.createServer());

      const discovery = await agent.client.callTool({
        name: "execute",
        arguments: {
          code: `const page = await tools.searchTools({ query: ${JSON.stringify(name)} });
          const result = await tools[${JSON.stringify(`notes.${name}`)}]({});
          return { names: page.tools.map(tool => tool.name), invoked: result.structuredContent.invoked };`,
        },
      });

      expect(gateway.status()).toMatchObject([
        {
          state: "connected",
          toolCount: 1,
        },
      ]);
      expect(responseValue(discovery)).toEqual({ names: [`notes.${name}`], invoked: name });
    },
  );

  test("paginates server-filtered discovery independently of other upstream matches", async () => {
    await using gateway = new Gateway(
      Configuration.parse({
        mcp: {
          servers: {
            "notes-backup": { type: "local", command: localCommand },
            notes: { type: "local", command: localCommand },
          },
        },
      }),
      ".",
    );

    await gateway.start();
    await using agent = await connect(gateway.createServer());

    const response = await agent.client.callTool({
      name: "execute",
      arguments: {
        code: `const first = await tools.searchTools({ query: "Return", server: "notes", limit: 1 });
          const second = await tools.searchTools({ query: "Return", server: "notes", limit: 1, offset: first.nextOffset });
          return { first, second };`,
      },
    });

    expect(responseValue(response)).toMatchObject({
      first: {
        tools: [{ name: "notes.dataset" }],
        total: 2,
        nextOffset: 1,
        servers: [{ name: "notes", state: "connected" }],
      },
      second: {
        tools: [{ name: "notes.fail" }],
        total: 2,
        nextOffset: null,
        servers: [{ name: "notes", state: "connected" }],
      },
    });
  });

  test.each([
    {
      name: "a non-string",
      server: 42,
      message: "searchTools server must be a server name string.",
    },
    {
      name: "an unknown",
      server: "absent",
      message: "Unknown server in this gateway.",
    },
  ])(
    "rejects $name server filter rather than searching all servers",
    async ({ server, message }) => {
      await using gateway = new Gateway(
        Configuration.parse({
          mcp: { servers: { notes: { type: "local", command: ["unused"], disabled: true } } },
        }),
        ".",
      );

      await gateway.start();
      await using agent = await connect(gateway.createServer());

      const response = await agent.client.callTool({
        name: "execute",
        arguments: {
          code: `return await tools.searchTools({ query: "add", server: ${JSON.stringify(server)} });`,
        },
      });

      expect(response.isError).toBe(true);
      expect(responseText(response)).toBe(message);
    },
  );

  test("namespaces duplicate tool names across stdio and HTTP without changing their schemas", async () => {
    const received: unknown[] = [];

    await using upstream = await oauthFixture({
      mcp: async (request) => {
        if (request.method !== "POST") return;

        const body: unknown = await request.clone().json();
        if (
          typeof body === "object" &&
          body !== null &&
          "method" in body &&
          body.method === "tools/call" &&
          "params" in body
        )
          received.push(body.params);
      },
    });

    const credentials = memoryCredentials(upstream.credentials());

    const options = {
      store: () => credentials.store,
      lockDirectory: upstream.lockDirectory,
    } satisfies CredentialOptions;

    await using gateway = new Gateway(
      Configuration.parse({
        mcp: {
          servers: {
            local: { type: "local", command: localCommand },
            notes: { type: "remote", url: upstream.url, oauth: {} },
          },
        },
      }),
      ".",
      options,
    );

    await gateway.start();
    await using agent = await connect(gateway.createServer());

    const response = await agent.client.callTool({
      name: "execute",
      arguments: {
        code: `
      const schema = await tools.describeTool({ name: "notes.add" });
      return { required: schema.inputSchema.required, values: await Promise.all([
        tools["local.add"]({ a: 2, b: 3 }).then(r => r.structuredContent.sum),
        tools["notes.add"]({ a: 10, b: 20 }).then(r => r.structuredContent.sum),
      ]) };
    `,
      },
    });

    expect(responseValue(response)).toEqual({ required: ["a", "b"], values: [5, 30] });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ name: "add", arguments: { a: 10, b: 20 } });
  });

  test("serves healthy tools and exposes failed and disabled servers without invoking them", async () => {
    await using gateway = new Gateway(
      Configuration.parse({
        mcp: {
          servers: {
            local: { type: "local", command: localCommand },
            broken: { type: "local", command: ["nonexistent-cmg-upstream"] },
            disabled: { type: "local", command: ["nonexistent-disabled-upstream"], disabled: true },
          },
        },
      }),
      ".",
    );

    await gateway.start();
    await using agent = await connect(gateway.createServer());

    const discovery = await agent.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools.searchTools({ query: "add" });' },
    });

    const selected = await agent.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools.searchTools({ query: "add", server: "broken" });' },
    });

    const healthy = await agent.client.callTool({
      name: "execute",
      arguments: {
        code: 'return (await tools["local.add"]({ a: 20, b: 22 })).structuredContent.sum;',
      },
    });

    expect(responseValue(discovery)).toMatchObject({
      tools: [{ name: "local.add" }],
      total: 1,
      nextOffset: null,
      servers: [
        { name: "local", state: "connected" },
        { name: "broken", state: "failed" },
        { name: "disabled", state: "disabled" },
      ],
    });
    expect(responseValue(selected)).toMatchObject({
      tools: [],
      total: 0,
      servers: [{ name: "broken", state: "failed" }],
    });
    expect(responseValue(healthy)).toBe(42);
  });
});
