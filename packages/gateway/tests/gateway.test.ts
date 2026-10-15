import { describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { type McpServer } from "@modelcontextprotocol/server";
import { fileURLToPath } from "node:url";
import { Configuration, Gateway, login, type CredentialStore } from "codemode-mcp-gateway";
import { memoryCredentials, oauthFixture } from "./support/oauth.ts";
import { configurationDocument } from "./support/configuration.ts";
import { rejectionOf } from "./support/rejection.ts";

const localCommand = [
  process.execPath,
  fileURLToPath(new URL("../../../examples/mcp-server.ts", import.meta.url)),
];

describe("multi-upstream gateway", () => {
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
    expect(response.structuredContent).toMatchObject({
      result: {
        ok: true,
        value: {
          tools: [{ name: "math.add" }],
          servers: [{ name: "math", state: "connected" }],
        },
      },
    });
  });

  test("close cancels initialization queued by start without opening an upstream", async () => {
    await using upstream = await oauthFixture();

    const gateway = new Gateway(
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

    const starting = gateway.start();
    const closing = gateway.close();
    await Promise.all([starting, closing]);

    expect(upstream.requests).toHaveLength(0);
    expect(gateway.close()).toBe(closing);
    expect(() => gateway.createServer()).toThrow("Gateway is closed.");
  });

  test("start remains single-flight when a status callback reenters it", async () => {
    let handshakes = 0;

    await using upstream = await oauthFixture({
      mcp: async (request) => {
        if (request.method !== "POST") return;

        const body: unknown = await request.clone().json();
        if (
          typeof body === "object" &&
          body !== null &&
          "method" in body &&
          body.method === "initialize"
        )
          handshakes++;
      },
    });

    let reentered = false;
    let nested: Promise<void> | undefined;

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
      {
        onStatus: (status) => {
          if (status.state !== "connecting" || reentered) return;

          reentered = true;
          nested = gateway.start();
        },
      },
    );

    const starting = gateway.start();
    await starting;
    await nested;

    expect(nested).toBe(starting);
    expect(handshakes).toBe(1);
    expect(gateway.status()).toMatchObject([{ state: "connected", toolCount: 1 }]);
  });

  test("expired HTTP sessions reconnect without replaying the failed call", async () => {
    let expired = "";
    let handshakes = 0;
    let calls = 0;

    await using upstream = await oauthFixture({
      mcp: async (request) => {
        if (request.method === "POST") {
          const body: unknown = await request.clone().json();
          if (typeof body === "object" && body !== null && "method" in body) {
            if (body.method === "initialize") handshakes++;

            if (body.method === "tools/call") calls++;
          }
        }

        if (request.headers.get("mcp-session-id") === expired)
          return new Response("Private expired-session detail", { status: 404 });
      },
    });

    const recovered = Promise.withResolvers<void>();
    let connections = 0;

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
      {
        onStatus: (status) => {
          if (status.state === "connected" && ++connections === 2) recovered.resolve();
        },
      },
    );

    await gateway.start();
    await using agent = await connect(gateway.createServer());

    const session =
      upstream.requests
        .find((request) => request.headers.has("mcp-session-id"))
        ?.headers.get("mcp-session-id") ?? "";

    expect(session).not.toBe("");
    expired = session;

    const failed = await agent.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools["notes.add"]({ a: 1, b: 2 });' },
    });

    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toContain("Private expired-session detail");
    expect(gateway.status()).toMatchObject([{ state: "failed", error: { kind: "connection" } }]);
    await within(recovered.promise, 8000);
    expect(handshakes).toBe(2);
    expect(calls).toBe(1);

    const result = await agent.client.callTool({
      name: "execute",
      arguments: {
        code: 'return (await tools["notes.add"]({ a: 20, b: 22 })).structuredContent.sum;',
      },
    });

    expect(result.structuredContent).toMatchObject({ result: { ok: true, value: 42 } });
    expect(calls).toBe(2);
    expect(
      upstream.requests.filter(
        (request) =>
          request.method === "DELETE" && request.headers.get("mcp-session-id") === expired,
      ),
    ).toHaveLength(0);
  }, 12_000);

  test.each([
    { name: "authorization metadata", path: "/.well-known/oauth-authorization-server" },
    { name: "resource metadata", path: "/metadata" },
  ])(
    "OAuth $name outages recover with unchanged credentials",
    async ({ path }) => {
      let available = false;

      await using upstream = await oauthFixture({
        auth: async (request) =>
          !available && new URL(request.url).pathname === path
            ? new Response("Private discovery outage", { status: 503 })
            : undefined,
      });

      const credentials = memoryCredentials(upstream.credentials());
      const ready = Promise.withResolvers<void>();

      await using gateway = new Gateway(
        Configuration.parse({
          mcp: { servers: { notes: { type: "remote", url: upstream.url, oauth: {} } } },
        }),
        ".",
        {
          store: () => credentials.store,
          lockDirectory: upstream.lockDirectory,
          onStatus: (status) => {
            if (status.state === "connected") ready.resolve();
          },
        },
      );

      await gateway.start();
      expect(gateway.status()).toMatchObject([{ state: "failed", error: { kind: "unavailable" } }]);
      expect(JSON.stringify(gateway.status())).not.toContain("Private discovery outage");
      available = true;
      await within(ready.promise, 8000);
      await using agent = await connect(gateway.createServer());

      const result = await agent.client.callTool({
        name: "execute",
        arguments: {
          code: 'return (await tools["notes.add"]({ a: 20, b: 22 })).structuredContent.sum;',
        },
      });

      expect(result.structuredContent).toMatchObject({ result: { ok: true, value: 42 } });
      expect(credentials.writes).toBe(0);
      expect(upstream.refreshes).toBe(0);
    },
    12_000,
  );

  test("a credential read failure before refresh recovers on the same connection without changing the grant", async () => {
    await using upstream = await oauthFixture();
    const credentials = memoryCredentials(upstream.credentials());
    let unavailable = false;

    const store: CredentialStore = {
      ...credentials.store,
      load: () =>
        unavailable
          ? Promise.resolve({
              ok: false,
              error: { kind: "storage", message: "Credential storage unavailable" },
            })
          : credentials.store.load(),
    };

    let connections = 0;

    await using gateway = new Gateway(
      Configuration.parse({
        mcp: { servers: { notes: { type: "remote", url: upstream.url, oauth: {} } } },
      }),
      ".",
      {
        store: () => store,
        lockDirectory: upstream.lockDirectory,
        onStatus: (status) => {
          if (status.state === "connected") connections++;
        },
      },
    );

    await gateway.start();
    await using agent = await connect(gateway.createServer());
    unavailable = true;

    const failed = await agent.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools["notes.add"]({ a: 1, b: 2 });' },
    });

    expect(failed.isError).toBe(true);
    expect(gateway.status()).toMatchObject([{ state: "connected" }]);
    unavailable = false;

    const result = await agent.client.callTool({
      name: "execute",
      arguments: {
        code: 'return (await tools["notes.add"]({ a: 20, b: 22 })).structuredContent.sum;',
      },
    });

    expect(result.structuredContent).toMatchObject({ result: { ok: true, value: 42 } });
    expect(credentials.writes).toBe(0);
    expect(upstream.refreshes).toBe(0);
    expect(connections).toBe(1);
  }, 12_000);

  test("credentials changed during startup reopen the connection instead of requiring another login", async () => {
    const discovering = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let broaderResource = false;

    await using upstream = await oauthFixture({
      auth: async (request) => {
        const url = new URL(request.url);
        if (!broaderResource && url.pathname === "/.well-known/oauth-authorization-server") {
          discovering.resolve();
          await release.promise;
        }

        if (
          broaderResource &&
          (url.pathname === "/metadata" ||
            url.pathname.startsWith("/.well-known/oauth-protected-resource"))
        )
          return Response.json({
            resource: new URL("/", url).href,
            authorization_servers: [new URL("/", url).href],
          });
      },
    });

    const initial = upstream.credentials();
    const credentials = memoryCredentials(initial);
    const ready = Promise.withResolvers<void>();

    await using gateway = new Gateway(
      Configuration.parse({
        mcp: { servers: { notes: { type: "remote", url: upstream.url, oauth: {} } } },
      }),
      ".",
      {
        store: () => credentials.store,
        lockDirectory: upstream.lockDirectory,
        onStatus: (status) => {
          if (status.state === "connected") ready.resolve();
        },
      },
    );

    using gates = new DisposableStack();
    gates.defer(() => release.resolve());

    const starting = gateway.start();
    await within(discovering.promise);
    broaderResource = true;
    await credentials.store.save({ ...initial, resource: upstream.issuer });
    release.resolve();
    await starting;

    expect(gateway.status()).toMatchObject([
      { state: "failed", error: { kind: "credentials-changed" } },
    ]);
    await within(ready.promise);
    await using agent = await connect(gateway.createServer());

    const result = await agent.client.callTool({
      name: "execute",
      arguments: {
        code: 'return (await tools["notes.add"]({ a: 20, b: 22 })).structuredContent.sum;',
      },
    });

    expect(result.structuredContent).toMatchObject({ result: { ok: true, value: 42 } });
    expect(credentials.writes).toBe(1);
    expect(upstream.refreshes).toBe(0);
  }, 10_000);

  test("cancelled startup preserves failed session deletion through failure and close", async () => {
    const discovering = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    await using upstream = await oauthFixture({
      mcp: async (request) => {
        if (request.method === "DELETE")
          return new Response("Private deletion failure", { status: 503 });

        if (request.method !== "POST") return;

        const body: unknown = await request.clone().json();
        if (
          typeof body === "object" &&
          body !== null &&
          "method" in body &&
          body.method === "tools/list"
        ) {
          discovering.resolve();
          await release.promise;
        }
      },
    });

    const gateway = new Gateway(
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

    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      await rejectionOf(gateway.close());
    });
    using gates = new DisposableStack();
    gates.defer(() => release.resolve());

    const starting = rejectionOf(gateway.start());
    await within(discovering.promise);
    const closing = rejectionOf(gateway.close());
    const failed = await within(starting);
    const closed = await within(closing);

    expect(failed.reason).toBeInstanceOf(SuppressedError);
    expect(await within(gateway.failure)).toBe(failed.reason);
    expect(closed.reason).toBeInstanceOf(AggregateError);
    expect(closed.reason).toHaveProperty("errors.0", failed.reason);
    expect(upstream.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
  });

  test.each(["searchTools", "describeTool"])(
    "qualifies an upstream %s tool without replacing the discovery helper",
    async (name) => {
      await using upstream = await oauthFixture({
        mcp: async (request) => {
          if (request.method !== "POST") return;

          const body: unknown = await request.clone().json();
          if (
            typeof body === "object" &&
            body !== null &&
            "method" in body &&
            body.method === "tools/list" &&
            "id" in body
          )
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: { tools: [{ name, inputSchema: { type: "object" } }] },
            });

          if (
            typeof body === "object" &&
            body !== null &&
            "method" in body &&
            body.method === "tools/call" &&
            "id" in body
          )
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
      expect(discovery.structuredContent).toMatchObject({
        result: { ok: true, value: { names: [`notes.${name}`], invoked: name } },
      });
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
      { store: () => credentials.store, lockDirectory: upstream.lockDirectory },
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

    expect(response.structuredContent).toMatchObject({
      result: { ok: true, value: { required: ["a", "b"], values: [5, 30] } },
      calls: [
        { name: "describeTool", status: "completed" },
        { name: "local.add", status: "completed" },
        { name: "notes.add", status: "completed" },
      ],
    });
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

    expect(discovery.structuredContent).toMatchObject({
      result: {
        ok: true,
        value: {
          tools: [{ name: "local.add" }],
          total: 1,
          nextOffset: null,
          servers: [
            { name: "local", state: "connected" },
            { name: "broken", state: "failed" },
            { name: "disabled", state: "disabled" },
          ],
        },
      },
    });
    expect(selected.structuredContent).toMatchObject({
      result: {
        ok: true,
        value: { tools: [], total: 0, servers: [{ name: "broken", state: "failed" }] },
      },
    });
    expect(healthy.structuredContent).toMatchObject({ result: { ok: true, value: 42 } });
  });

  test("an initially unauthenticated server becomes usable after named login without replacing the MCP connection", async () => {
    await using upstream = await oauthFixture();
    const credentials = memoryCredentials();
    const input = { mcp: { servers: { notes: { type: "remote", url: upstream.url, oauth: {} } } } };
    await using file = await configurationDocument(input);
    const ready = Promise.withResolvers<void>();

    await using gateway = new Gateway(Configuration.parse(input), ".", {
      store: () => credentials.store,
      lockDirectory: upstream.lockDirectory,
      onStatus: (status) => {
        if (status.name === "notes" && status.state === "connected") ready.resolve();
      },
    });

    await gateway.start();
    await using agent = await connect(gateway.createServer());
    expect(gateway.status()).toMatchObject([{ name: "notes", state: "needs-auth" }]);

    const result = await login(file.path, {
      server: "notes",
      store: () => credentials.store,
      lockDirectory: upstream.lockDirectory,
      authorize: async (url) => {
        await fetch(await upstream.authorize(url));
      },
    });

    expect(result).toEqual({ ok: true, value: undefined });
    await within(ready.promise);

    const response = await agent.client.callTool({
      name: "execute",
      arguments: {
        code: 'return (await tools["notes.add"]({ a: 2, b: 3 })).structuredContent.sum;',
      },
    });

    expect(response.structuredContent).toMatchObject({ result: { ok: true, value: 5 } });
    expect(gateway.status()).toMatchObject([{ name: "notes", state: "connected", toolCount: 1 }]);
    expect(upstream.exchanges).toBe(1);
  }, 10_000);

  test("revoked authorization recovers after login while a healthy upstream stays available", async () => {
    await using upstream = await oauthFixture({
      refresh: async () =>
        Response.json(
          { error: "invalid_grant", error_description: "private revoked grant" },
          { status: 400 },
        ),
    });

    const credentials = memoryCredentials();

    const input = {
      mcp: {
        servers: {
          notes: { type: "remote", url: upstream.url, oauth: {} },
          local: { type: "local", command: localCommand },
        },
      },
    };

    await using file = await configurationDocument(input);
    expect(
      await login(file.path, {
        server: "notes",
        store: () => credentials.store,
        lockDirectory: upstream.lockDirectory,
        authorize: async (url) => {
          await fetch(await upstream.authorize(url));
        },
      }),
    ).toEqual({ ok: true, value: undefined });
    const recovered = Promise.withResolvers<void>();
    let connections = 0;

    await using gateway = new Gateway(Configuration.parse(input), ".", {
      store: () => credentials.store,
      lockDirectory: upstream.lockDirectory,
      onStatus: (status) => {
        if (status.name === "notes" && status.state === "connected" && ++connections === 2)
          recovered.resolve();
      },
    });

    await gateway.start();
    await using agent = await connect(gateway.createServer());
    upstream.rejectAccess();

    const denied = await agent.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools["notes.add"]({ a: 2, b: 3 });' },
    });

    const healthy = await agent.client.callTool({
      name: "execute",
      arguments: {
        code: 'return (await tools["local.add"]({ a: 1, b: 2 })).structuredContent.sum;',
      },
    });

    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain("cmg login --server notes");
    expect(JSON.stringify(denied)).not.toContain("private revoked grant");
    expect(gateway.status()).toMatchObject([{ state: "needs-auth" }, { state: "connected" }]);
    expect(healthy.structuredContent).toMatchObject({ result: { ok: true, value: 3 } });

    expect(
      await login(file.path, {
        server: "notes",
        store: () => credentials.store,
        lockDirectory: upstream.lockDirectory,
        authorize: async (url) => {
          await fetch(await upstream.authorize(url));
        },
      }),
    ).toEqual({ ok: true, value: undefined });
    await within(recovered.promise);

    const response = await agent.client.callTool({
      name: "execute",
      arguments: {
        code: 'return (await tools["notes.add"]({ a: 4, b: 5 })).structuredContent.sum;',
      },
    });

    expect(response.structuredContent).toMatchObject({ result: { ok: true, value: 9 } });
    expect(upstream.refreshes).toBe(1);
    expect(upstream.exchanges).toBe(2);
  }, 10_000);

  test("catalog recovery preserves an active snapshot and the executor budget across MCP clients", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    await using first = await oauthFixture({
      mcp: async (request) => {
        if (request.method !== "POST") return;

        const body: unknown = await request.clone().json();
        if (
          typeof body === "object" &&
          body !== null &&
          "method" in body &&
          body.method === "tools/call"
        ) {
          started.resolve();
          await release.promise;
        }
      },
    });

    await using late = await oauthFixture();
    const firstCredentials = memoryCredentials(first.credentials());
    const lateCredentials = memoryCredentials();
    const ready = Promise.withResolvers<void>();

    await using gateway = new Gateway(
      Configuration.parse({
        sandbox: { maxConcurrentExecutions: 1 },
        mcp: {
          servers: {
            first: { type: "remote", url: first.url, oauth: {} },
            late: { type: "remote", url: late.url, oauth: {} },
          },
        },
      }),
      ".",
      {
        store: (connection) =>
          connection.id === "first" ? firstCredentials.store : lateCredentials.store,
        lockDirectory: first.lockDirectory,
        onStatus: (status) => {
          if (status.name === "late" && status.state === "connected") ready.resolve();
        },
      },
    );

    await gateway.start();
    await using a = await connect(gateway.createServer());
    await using b = await connect(gateway.createServer());
    using gates = new DisposableStack();
    gates.defer(() => release.resolve());

    const running = a.client.callTool({
      name: "execute",
      arguments: {
        code: `await tools["first.add"]({ a: 1, b: 1 });
          const page = await tools.searchTools({ query: "add", server: "late" });
          return { binding: typeof tools["late.add"], total: page.total, state: page.servers[0].state };`,
      },
    });

    await within(started.promise);
    await lateCredentials.store.save(late.credentials());
    await within(ready.promise);

    const rejected = await b.client.callTool({
      name: "execute",
      arguments: { code: "return 42;" },
    });

    release.resolve();
    const previous = await running;

    const next = await b.client.callTool({
      name: "execute",
      arguments: {
        code: `const page = await tools.searchTools({ query: "add", server: "late" });
          const result = await tools["late.add"]({ a: 3, b: 4 });
          return { sum: result.structuredContent.sum, total: page.total, state: page.servers[0].state };`,
      },
    });

    expect(rejected.structuredContent).toMatchObject({
      result: { ok: false, error: { kind: "limit", resource: "executions", maximum: 1 } },
      calls: [],
    });
    expect(previous.structuredContent).toMatchObject({
      result: { ok: true, value: { binding: "undefined", total: 0, state: "needs-auth" } },
    });
    expect(next.structuredContent).toMatchObject({
      result: { ok: true, value: { sum: 7, total: 1, state: "connected" } },
    });
  }, 10_000);

  test("reopens an upstream after login changes its OAuth resource binding", async () => {
    let broaderResource = false;

    await using upstream = await oauthFixture({
      auth: async (request) => {
        const url = new URL(request.url);
        if (
          broaderResource &&
          (url.pathname === "/metadata" ||
            url.pathname.startsWith("/.well-known/oauth-protected-resource"))
        ) {
          return Response.json({
            resource: new URL("/", url).href,
            authorization_servers: [new URL("/", url).href],
          });
        }
      },
    });

    const credentials = memoryCredentials();
    const input = { mcp: { servers: { notes: { type: "remote", url: upstream.url, oauth: {} } } } };
    await using file = await configurationDocument(input);

    const options = {
      server: "notes",
      store: () => credentials.store,
      lockDirectory: upstream.lockDirectory,
      authorize: async (url: URL) => {
        await fetch(await upstream.authorize(url));
      },
    };

    expect(await login(file.path, options)).toEqual({ ok: true, value: undefined });
    const recovered = Promise.withResolvers<void>();
    let connections = 0;

    await using gateway = new Gateway(Configuration.parse(input), ".", {
      ...options,
      onStatus: (status) => {
        if (status.state === "connected" && ++connections === 2) recovered.resolve();
      },
    });

    await gateway.start();
    await using agent = await connect(gateway.createServer());

    broaderResource = true;
    expect(await login(file.path, options)).toEqual({ ok: true, value: undefined });

    const outdated = await agent.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools["notes.add"]({ a: 1, b: 2 });' },
    });

    expect(outdated.isError).toBe(true);
    expect(JSON.stringify(outdated)).toContain("recovering automatically");
    await within(recovered.promise);

    const response = await agent.client.callTool({
      name: "execute",
      arguments: {
        code: 'return (await tools["notes.add"]({ a: 20, b: 22 })).structuredContent.sum;',
      },
    });

    expect(response.structuredContent).toMatchObject({ result: { ok: true, value: 42 } });
    expect(upstream.exchanges).toBe(2);
  }, 10_000);

  test.each([
    { name: "an uncertain refresh", refreshFails: true, kind: "unavailable" },
    { name: "an unpersisted rotation", refreshFails: false, kind: "storage" },
  ])(
    "does not retry $name until credentials change",
    async ({ refreshFails, kind }) => {
      await using upstream = await oauthFixture({
        refresh: async () =>
          refreshFails ? new Response("private refresh outage", { status: 503 }) : undefined,
      });

      const credentials = memoryCredentials(upstream.credentials());
      const observed = Promise.withResolvers<void>();
      let waitingForLogin = false;

      const store: CredentialStore = {
        ...credentials.store,
        async save(record) {
          if (!refreshFails)
            return {
              ok: false,
              error: { kind: "storage", message: "Rotated credentials could not be saved." },
            };

          return credentials.store.save(record);
        },
        async load() {
          const result = await credentials.store.load();
          if (waitingForLogin) observed.resolve();

          return result;
        },
      };

      await using gateway = new Gateway(
        Configuration.parse({
          mcp: { servers: { notes: { type: "remote", url: upstream.url, oauth: {} } } },
        }),
        ".",
        {
          store: () => store,
          lockDirectory: upstream.lockDirectory,
          onStatus: (status) => {
            if (status.state === "needs-auth") waitingForLogin = true;
          },
        },
      );

      await gateway.start();
      await using agent = await connect(gateway.createServer());
      upstream.rejectAccess();

      const response = await agent.client.callTool({
        name: "execute",
        arguments: { code: 'return await tools["notes.add"]({ a: 1, b: 2 });' },
      });

      await within(observed.promise);

      expect(response.isError).toBe(true);
      expect(upstream.refreshes).toBe(1);
      expect(gateway.status()).toMatchObject([{ state: "needs-auth", error: { kind } }]);
    },
    10_000,
  );

  test("an uncertain startup refresh waits for changed credentials instead of reconnecting", async () => {
    await using upstream = await oauthFixture({
      refresh: async () => new Response("Private token exchange outage", { status: 503 }),
    });

    const credentials = memoryCredentials(upstream.credentials(0));
    const observed = Promise.withResolvers<void>();
    let waitingForLogin = false;

    const store: CredentialStore = {
      ...credentials.store,
      async load() {
        const loaded = await credentials.store.load();
        if (waitingForLogin) observed.resolve();

        return loaded;
      },
    };

    await using gateway = new Gateway(
      Configuration.parse({
        mcp: { servers: { notes: { type: "remote", url: upstream.url, oauth: {} } } },
      }),
      ".",
      {
        store: () => store,
        lockDirectory: upstream.lockDirectory,
        onStatus: (status) => {
          if (status.state === "needs-auth") waitingForLogin = true;
        },
      },
    );

    await gateway.start();
    await within(observed.promise);

    expect(gateway.status()).toMatchObject([
      { state: "needs-auth", error: { kind: "unavailable" } },
    ]);
    expect(upstream.refreshes).toBe(1);
    expect(
      upstream.requests.filter((request) => request.path === "/mcp" && request.method === "POST"),
    ).toHaveLength(0);
  });

  test("a failed connection automatically recovers after the upstream becomes available", async () => {
    let available = false;

    await using upstream = await oauthFixture({
      mcp: async () =>
        available ? undefined : new Response("private startup failure", { status: 503 }),
    });

    const credentials = memoryCredentials(upstream.credentials());
    const ready = Promise.withResolvers<void>();

    await using gateway = new Gateway(
      Configuration.parse({
        mcp: { servers: { notes: { type: "remote", url: upstream.url, oauth: {} } } },
      }),
      ".",
      {
        store: () => credentials.store,
        lockDirectory: upstream.lockDirectory,
        onStatus: (status) => {
          if (status.state === "connected") ready.resolve();
        },
      },
    );

    await gateway.start();
    expect(gateway.status()).toMatchObject([{ state: "failed", error: { kind: "connect" } }]);
    await using agent = await connect(gateway.createServer());

    available = true;
    await within(ready.promise, 8000);

    const result = await agent.client.callTool({
      name: "execute",
      arguments: {
        code: 'return (await tools["notes.add"]({ a: 5, b: 6 })).structuredContent.sum;',
      },
    });

    expect(result.structuredContent).toMatchObject({ result: { ok: true, value: 11 } });
  }, 12_000);
});

async function connect(server: McpServer) {
  await using setup = new AsyncDisposableStack();
  setup.defer(() => server.close());
  const client = new Client({ name: "multi-upstream-test", version: "0" });
  setup.defer(() => client.close());
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote);
  await client.connect(local);
  const cleanup = setup.move();

  return { client, [Symbol.asyncDispose]: () => cleanup.disposeAsync() };
}

async function within<T>(promise: Promise<T>, ms = 4000): Promise<T> {
  const deadline = Promise.withResolvers<never>();

  const timer = setTimeout(
    () => deadline.reject(new Error("Expected gateway state transition did not arrive.")),
    ms,
  );

  try {
    return await Promise.race([promise, deadline.promise]);
  } finally {
    clearTimeout(timer);
  }
}
