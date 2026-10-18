import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Configuration, Gateway, login, type CredentialStore } from "codemode-mcp-gateway";
import { memoryCredentials, oauthFixture } from "./support/oauth.ts";
import { configurationDocument } from "./support/configuration.ts";
import { connect, within } from "./support/gateway.ts";
import { responseText, responseValue } from "./support/output.ts";

const localCommand = [
  process.execPath,
  fileURLToPath(new URL("../../../examples/shared/mcp-server.ts", import.meta.url)),
];

describe("gateway connection and authorization recovery", () => {
  test("login guidance selects a leading-hyphen server name without an option parsing error", async () => {
    const memory = memoryCredentials();

    await using gateway = new Gateway(
      Configuration.parse({
        mcp: {
          servers: {
            "-notes": {
              type: "remote",
              url: "https://example.com/mcp",
              oauth: {},
            },
          },
        },
      }),
      ".",
      { store: () => memory.store },
    );

    await gateway.start();
    const status = gateway.status()[0];
    if (status === undefined || !("error" in status))
      throw new Error("Expected authorization guidance.");

    const argument = status.error.message.match(/Run gw auth login -- (\S+) with/)?.[1];
    if (argument === undefined) throw new Error("Missing login server argument.");

    expect(parseArgs({ args: ["--", argument], allowPositionals: true }).positionals).toEqual([
      "-notes",
    ]);
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

    expect(responseValue(result)).toBe(42);
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

      expect(responseValue(result)).toBe(42);
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

    expect(responseValue(result)).toBe(42);
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
    expect(gateway.listTools().tools).toEqual([]);
    await within(ready.promise);
    expect(gateway.listTools().tools).toEqual([
      { server: "notes", name: "notes.add", description: "Add two numbers" },
    ]);
    await using agent = await connect(gateway.createServer());

    const result = await agent.client.callTool({
      name: "execute",
      arguments: {
        code: 'return (await tools["notes.add"]({ a: 20, b: 22 })).structuredContent.sum;',
      },
    });

    expect(responseValue(result)).toBe(42);
    expect(credentials.writes).toBe(1);
    expect(upstream.refreshes).toBe(0);
  }, 10_000);

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

    expect(responseValue(response)).toBe(5);
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
    expect(JSON.stringify(denied)).toContain("gw auth login -- notes");
    expect(JSON.stringify(denied)).not.toContain("private revoked grant");
    expect(gateway.status()).toMatchObject([{ state: "needs-auth" }, { state: "connected" }]);
    expect(responseValue(healthy)).toBe(3);

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

    expect(responseValue(response)).toBe(9);
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

    expect(rejected.isError).toBe(true);
    expect(responseText(rejected)).toBe("Executor reached the 1 concurrent-execution limit.");
    expect(responseValue(previous)).toEqual({
      binding: "undefined",
      total: 0,
      state: "needs-auth",
    });
    expect(responseValue(next)).toEqual({ sum: 7, total: 1, state: "connected" });
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

    expect(responseValue(response)).toBe(42);
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

    expect(responseValue(result)).toBe(11);
  }, 12_000);
});
