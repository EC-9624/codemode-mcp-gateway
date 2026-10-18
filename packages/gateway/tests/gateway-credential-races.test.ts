import { describe, expect, spyOn, test } from "bun:test";
import { Configuration, Gateway } from "codemode-mcp-gateway";
import { memoryCredentials, oauthFixture } from "./support/oauth.ts";
import { connect, within } from "./support/gateway.ts";
import { responseValue } from "./support/output.ts";

describe("gateway retired credential races", () => {
  test("session expiry cannot erase an uncertain refresh failure for unchanged credentials", async () => {
    await using race = await retiringOAuthSession();
    const memory = memoryCredentials(race.upstream.credentials());
    const recovered = Promise.withResolvers<void>();
    let connections = 0;
    const now = Date.now();
    using clock = spyOn(Date, "now").mockReturnValue(now);

    await using gateway = new Gateway(
      Configuration.parse({
        mcp: {
          servers: {
            notes: {
              type: "remote",
              url: race.upstream.url,
              oauth: {},
            },
          },
        },
      }),
      ".",
      {
        store: () => memory.store,
        lockDirectory: race.upstream.lockDirectory,
        onStatus: (status) => {
          if (status.state === "connected" && ++connections === 2) recovered.resolve();
        },
      },
    );

    using gates = new DisposableStack();
    gates.defer(() => {
      race.expire.resolve();
      race.failRefresh.resolve();
      race.publish.resolve();
    });
    await gateway.start();
    await using agent = await connect(gateway.createServer());

    const expired = agent.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools["notes.add"]({ a: 1, b: 0 });' },
    });

    await within(race.held.promise);

    const failed = agent.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools["notes.add"]({ a: 2, b: 0 });' },
    });

    await within(race.refreshing.promise);
    race.expire.resolve();
    await expired;
    expect(gateway.status()).toMatchObject([{ state: "failed" }]);
    race.failRefresh.resolve();
    expect((await failed).isError).toBe(true);
    expect(gateway.status()).toMatchObject([{ state: "needs-auth" }]);

    // Advance beyond reconnect backoff; unchanged credentials must stay blocked.
    clock.mockReturnValue(now + 60_000);
    await Bun.sleep(1100);
    expect(connections).toBe(1);
    expect(race.upstream.refreshes).toBe(1);
    expect(gateway.status()).toMatchObject([{ state: "needs-auth" }]);

    await memory.store.save(race.upstream.credentials(now + 60_000));
    race.publish.resolve();
    await within(recovered.promise);

    const response = await agent.client.callTool({
      name: "execute",
      arguments: {
        code: 'return (await tools["notes.add"]({ a: 3, b: 4 })).structuredContent.sum;',
      },
    });

    expect(responseValue(response)).toBe(7);
    expect(race.upstream.refreshes).toBe(1);
  }, 10000);

  test("a retired session's terminal failure blocks a replacement already initializing with the same grant", async () => {
    await using race = await retiringOAuthSession();
    const memory = memoryCredentials(race.upstream.credentials());
    const denied = Promise.withResolvers<void>();
    const now = Date.now();
    using clock = spyOn(Date, "now").mockReturnValue(now);

    await using gateway = new Gateway(
      Configuration.parse({
        mcp: {
          servers: {
            notes: {
              type: "remote",
              url: race.upstream.url,
              oauth: {},
            },
          },
        },
      }),
      ".",
      {
        store: () => memory.store,
        lockDirectory: race.upstream.lockDirectory,
        onStatus: (status) => {
          if (status.state === "needs-auth") denied.resolve();
        },
      },
    );

    using gates = new DisposableStack();
    gates.defer(() => {
      race.expire.resolve();
      race.failRefresh.resolve();
      race.publish.resolve();
    });
    await gateway.start();
    await using agent = await connect(gateway.createServer());

    const expired = agent.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools["notes.add"]({ a: 1, b: 0 });' },
    });

    await within(race.held.promise);

    const failed = agent.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools["notes.add"]({ a: 2, b: 0 });' },
    });

    await within(race.refreshing.promise);
    race.expire.resolve();
    await expired;
    clock.mockReturnValue(now + 60_000);
    await within(race.replacing.promise);
    race.failRefresh.resolve();
    expect((await failed).isError).toBe(true);
    race.publish.resolve();
    await within(denied.promise);

    expect(gateway.status()).toMatchObject([{ state: "needs-auth" }]);
    expect(race.handshakes).toBe(2);
    expect(race.upstream.refreshes).toBe(1);
  }, 10000);

  test("a retired session's terminal failure also retires a connected replacement using the same grant", async () => {
    await using race = await retiringOAuthSession();
    const memory = memoryCredentials(race.upstream.credentials());
    const recovered = Promise.withResolvers<void>();
    let connections = 0;
    const now = Date.now();
    using clock = spyOn(Date, "now").mockReturnValue(now);

    await using gateway = new Gateway(
      Configuration.parse({
        mcp: {
          servers: {
            notes: {
              type: "remote",
              url: race.upstream.url,
              oauth: {},
            },
          },
        },
      }),
      ".",
      {
        store: () => memory.store,
        lockDirectory: race.upstream.lockDirectory,
        onStatus: (status) => {
          if (status.state === "connected" && ++connections === 2) recovered.resolve();
        },
      },
    );

    using gates = new DisposableStack();
    gates.defer(() => {
      race.expire.resolve();
      race.failRefresh.resolve();
      race.publish.resolve();
    });
    await gateway.start();
    await using agent = await connect(gateway.createServer());

    const expired = agent.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools["notes.add"]({ a: 1, b: 0 });' },
    });

    await within(race.held.promise);

    const failed = agent.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools["notes.add"]({ a: 2, b: 0 });' },
    });

    await within(race.refreshing.promise);
    race.expire.resolve();
    await expired;
    clock.mockReturnValue(now + 60_000);
    await within(race.replacing.promise);
    race.publish.resolve();
    await within(recovered.promise);
    race.failRefresh.resolve();
    expect((await failed).isError).toBe(true);

    expect(gateway.status()).toMatchObject([{ state: "needs-auth" }]);
    expect(race.upstream.refreshes).toBe(1);
  }, 10000);

  test("a retired session's terminal failure cannot invalidate a newer authorized grant", async () => {
    await using race = await retiringOAuthSession();
    const memory = memoryCredentials(race.upstream.credentials());
    const recovered = Promise.withResolvers<void>();
    let connections = 0;
    const now = Date.now();
    using clock = spyOn(Date, "now").mockReturnValue(now);

    await using gateway = new Gateway(
      Configuration.parse({
        mcp: {
          servers: {
            notes: {
              type: "remote",
              url: race.upstream.url,
              oauth: {},
            },
          },
        },
      }),
      ".",
      {
        store: () => memory.store,
        lockDirectory: race.upstream.lockDirectory,
        onStatus: (status) => {
          if (status.state === "connected" && ++connections === 2) recovered.resolve();
        },
      },
    );

    using gates = new DisposableStack();
    gates.defer(() => {
      race.expire.resolve();
      race.failRefresh.resolve();
      race.publish.resolve();
    });
    await gateway.start();
    await using agent = await connect(gateway.createServer());

    const expired = agent.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools["notes.add"]({ a: 1, b: 0 });' },
    });

    await within(race.held.promise);

    const failed = agent.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools["notes.add"]({ a: 2, b: 0 });' },
    });

    await within(race.refreshing.promise);
    race.expire.resolve();
    await expired;
    await memory.store.save(race.upstream.credentials(now + 60_000));
    clock.mockReturnValue(now + 60_000);
    await within(race.replacing.promise);
    race.publish.resolve();
    await within(recovered.promise);
    race.failRefresh.resolve();
    expect((await failed).isError).toBe(true);

    const response = await agent.client.callTool({
      name: "execute",
      arguments: {
        code: 'return (await tools["notes.add"]({ a: 3, b: 4 })).structuredContent.sum;',
      },
    });

    expect(gateway.status()).toMatchObject([{ state: "connected" }]);
    expect(responseValue(response)).toBe(7);
    expect(race.upstream.refreshes).toBe(1);
  }, 10000);
});

/** Gate independent HTTP calls and a replacement handshake; tests own their ordering. */
async function retiringOAuthSession() {
  const held = Promise.withResolvers<void>();
  const expire = Promise.withResolvers<void>();
  const refreshing = Promise.withResolvers<void>();
  const failRefresh = Promise.withResolvers<void>();
  const replacing = Promise.withResolvers<void>();
  const publish = Promise.withResolvers<void>();
  let handshakes = 0;

  const upstream = await oauthFixture({
    mcp: async (request) => {
      if (request.method !== "POST") return;

      const body: unknown = await request.clone().json();
      if (typeof body !== "object" || body === null || !("method" in body)) return;

      if (body.method === "initialize" && ++handshakes === 2) {
        replacing.resolve();
        await publish.promise;
      }

      if (body.method !== "tools/call" || !("params" in body)) return;

      const params = body.params;
      if (typeof params !== "object" || params === null || !("arguments" in params)) return;

      const args = params.arguments;
      if (typeof args !== "object" || args === null || !("a" in args)) return;

      if (args.a === 1) {
        held.resolve();
        await expire.promise;

        return new Response("Expired session", { status: 404 });
      }

      if (args.a === 2)
        return new Response(null, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
    },
    refresh: async () => {
      refreshing.resolve();
      await failRefresh.promise;

      return new Response("Private uncertain exchange", { status: 503 });
    },
  });

  return {
    upstream,
    held,
    expire,
    refreshing,
    failRefresh,
    replacing,
    publish,
    get handshakes() {
      return handshakes;
    },
    [Symbol.asyncDispose]: () => upstream[Symbol.asyncDispose](),
  };
}
