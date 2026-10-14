import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gatewayProcess } from "../support/gateway-process.ts";
import { oauthFixture } from "../support/oauth.ts";
import { rejectionOf } from "../support/rejection.ts";

async function credentialFiles(value: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "cmg-auth-process-"));
  const path = join(directory, "credentials.json");
  await Bun.write(path, JSON.stringify(value));

  return {
    environment: { CMG_TEST_CREDENTIALS: path, CMG_TEST_LOCKS: join(directory, "locks") },
    path,
    [Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true }),
  };
}

const entry = fileURLToPath(new URL("../fixtures/oauth-gateway.ts", import.meta.url));

describe("OAuth-backed stdio gateway", () => {
  test("two gateway processes stay connected and share one rotating-token refresh", async () => {
    const refreshing = Promise.withResolvers<void>();
    const challenged = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let challenges = 0;
    let connected = false;

    await using upstream = await oauthFixture({
      unauthorized: () => {
        if (connected && ++challenges === 2) challenged.resolve();
      },
      refresh: async () => {
        refreshing.resolve();
        await release.promise;

        return undefined;
      },
    });

    await using files = await credentialFiles(upstream.credentials());

    const options = {
      entry,
      environment: files.environment,
      upstream: { id: "test", transport: "http", url: upstream.url, auth: { type: "oauth" } },
    } as const;

    await using first = await gatewayProcess(options);
    await using second = await gatewayProcess(options);

    await Promise.all([
      first.client.connect(first.transport, { timeout: 4_000 }),
      second.client.connect(second.transport, { timeout: 4_000 }),
    ]);
    connected = true;
    upstream.rejectAccess();

    const input = {
      name: "execute",
      arguments: { code: "return (await tools.add({ a: 2, b: 3 })).structuredContent.sum;" },
    };

    const requests = Promise.all([first.client.callTool(input), second.client.callTool(input)]);
    try {
      await Promise.all([refreshing.promise, challenged.promise]);
      expect(upstream.refreshes).toBe(1);
    } finally {
      release.resolve();
    }

    for (const result of await requests) {
      expect(result.structuredContent).toMatchObject({ result: { ok: true, value: 5 } });
    }

    expect(upstream.refreshes).toBe(1);
    expect(await Bun.file(files.path).json()).toMatchObject({
      authorization: { tokens: { refresh_token: "refresh-1" } },
    });
    first.child.stdin.end();
    second.child.stdin.end();
    expect(await first.closed).toEqual({ code: 0, signal: null });
    expect(await second.closed).toEqual({ code: 0, signal: null });
  }, 10_000);

  test("logout from another process removes authorization from a running gateway", async () => {
    await using upstream = await oauthFixture();
    await using files = await credentialFiles(upstream.credentials());

    await using app = await gatewayProcess({
      entry,
      environment: files.environment,
      upstream: { id: "test", transport: "http", url: upstream.url, auth: { type: "oauth" } },
    });

    await app.client.connect(app.transport, { timeout: 4_000 });

    const logout = Bun.spawn(
      [process.execPath, "--conditions=development", entry, "logout", app.config],
      {
        env: { ...process.env, ...files.environment },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 4_000,
      },
    );

    expect(await logout.exited).toBe(0);
    expect(await Bun.file(files.path).exists()).toBe(false);

    const response = await app.client.callTool({
      name: "execute",
      arguments: { code: "return await tools.add({ a: 2, b: 3 });" },
    });

    expect(response.structuredContent).toMatchObject({
      result: { ok: false, error: { kind: "script" } },
    });
    expect(JSON.stringify(response.structuredContent)).toContain("cmg login");
    expect(upstream.refreshes).toBe(0);
    app.child.stdin.end();
    expect(await app.closed).toEqual({ code: 0, signal: null });
  }, 10_000);

  test("scope denial does not refresh tokens or start interactive authorization", async () => {
    await using upstream = await oauthFixture({
      mcp: async (request) => {
        if (request.method !== "POST") return undefined;

        const body: unknown = await request.clone().json();
        if (
          typeof body === "object" &&
          body !== null &&
          "method" in body &&
          body.method === "tools/call"
        ) {
          return new Response("private scope detail", {
            status: 403,
            headers: { "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="write"' },
          });
        }

        return undefined;
      },
    });

    await using files = await credentialFiles(upstream.credentials());

    await using app = await gatewayProcess({
      entry,
      environment: files.environment,
      upstream: { id: "test", transport: "http", url: upstream.url, auth: { type: "oauth" } },
    });

    await app.client.connect(app.transport, { timeout: 4_000 });

    const result = await app.client.callTool({
      name: "execute",
      arguments: { code: "return await tools.add({ a: 2, b: 3 });" },
    });

    expect(result.structuredContent).toMatchObject({
      result: { ok: false, error: { kind: "script" } },
    });
    expect(JSON.stringify(result.structuredContent)).toContain("scope");
    expect(JSON.stringify(result)).not.toContain("private scope detail");
    expect(upstream.refreshes).toBe(0);
    expect(upstream.registrations).toBe(0);
  }, 10_000);

  test("unexpected credential-store exceptions remain private at the CLI boundary", async () => {
    await using upstream = await oauthFixture();
    await using files = await credentialFiles(upstream.credentials());

    await Bun.write(files.path, "private-malformed-credential-data");

    await using app = await gatewayProcess({
      entry,
      environment: files.environment,
      upstream: { id: "test", transport: "http", url: upstream.url, auth: { type: "oauth" } },
    });

    await rejectionOf(app.client.connect(app.transport, { timeout: 4_000 }));

    expect(await app.closed).toEqual({ code: 1, signal: null });
    expect(app.stderr).toContain("Private diagnostics were not displayed");
    expect(app.stderr).not.toContain("private-malformed-credential-data");
  }, 10_000);
  test("discovers, executes, refreshes once after a challenge, and closes its HTTP session", async () => {
    await using upstream = await oauthFixture();
    await using files = await credentialFiles(upstream.credentials());

    await using app = await gatewayProcess({
      entry,
      environment: files.environment,
      upstream: { id: "test", transport: "http", url: upstream.url, auth: { type: "oauth" } },
    });

    await app.client.connect(app.transport, { timeout: 4_000 });

    const discovered = await app.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools.describeTool({ name: "add" });' },
    });

    expect(discovered.structuredContent).toMatchObject({
      result: { ok: true, value: { name: "add" } },
    });
    upstream.rejectAccess();

    const result = await app.client.callTool({
      name: "execute",
      arguments: { code: "return (await tools.add({ a: 2, b: 3 })).structuredContent.sum;" },
    });

    expect(result.structuredContent).toMatchObject({
      result: { ok: true, value: 5 },
      calls: [{ name: "add", status: "completed" }],
    });
    expect(upstream.refreshes).toBe(1);
    expect(await Bun.file(files.path).json()).toMatchObject({
      authorization: { tokens: { refresh_token: "refresh-1" } },
    });
    app.child.stdin.end();

    expect(await app.closed).toEqual({ code: 0, signal: null });
    expect(
      upstream.requests.some((request) => request.path === "/mcp" && request.method === "DELETE"),
    ).toBe(true);
    expect(app.stderr).not.toContain("access-");
    expect(app.stderr).not.toContain("refresh-");
  }, 10_000);

  test("EOF exits cleanly when session deletion would require token refresh", async () => {
    await using upstream = await oauthFixture();
    await using files = await credentialFiles(upstream.credentials());

    await using app = await gatewayProcess({
      entry,
      environment: files.environment,
      upstream: { id: "test", transport: "http", url: upstream.url, auth: { type: "oauth" } },
    });

    await app.client.connect(app.transport, { timeout: 4_000 });
    await Bun.write(files.path, JSON.stringify(upstream.credentials(Date.now() - 4_000_000)));
    app.child.stdin.end();

    expect(await app.closed).toEqual({ code: 0, signal: null });
    expect(upstream.refreshes).toBe(0);
    expect(upstream.requests.some((request) => request.method === "DELETE")).toBe(false);
    expect(app.stderr).not.toContain("OAuth operation was cancelled");
  }, 10_000);

  test("shutdown during refresh exits cleanly without retrying or persisting tokens", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    await using upstream = await oauthFixture({
      refresh: async () => {
        started.resolve();
        await release.promise;

        return undefined;
      },
    });

    const credentials = upstream.credentials();
    await using files = await credentialFiles(credentials);

    await using app = await gatewayProcess({
      entry,
      environment: files.environment,
      upstream: { id: "test", transport: "http", url: upstream.url, auth: { type: "oauth" } },
    });

    await app.client.connect(app.transport, { timeout: 4_000 });
    upstream.rejectAccess();

    const request = rejectionOf(
      app.client.callTool({
        name: "execute",
        arguments: { code: "return await tools.add({ a: 2, b: 3 });" },
      }),
    );

    try {
      await started.promise;
      app.child.kill("SIGTERM");
      await request;

      expect(await app.closed).toEqual({ code: 0, signal: null });
      expect(await Bun.file(files.path).json()).toEqual(credentials);
      expect(upstream.refreshes).toBe(1);
      expect(upstream.requests.some((request) => request.method === "DELETE")).toBe(false);
      expect(app.stderr).not.toContain("OAuth operation was cancelled");
    } finally {
      release.resolve();
    }
  }, 10_000);

  test("missing authorization fails startup without dispatching to upstream", async () => {
    await using upstream = await oauthFixture();

    await using files = await credentialFiles({
      ...upstream.credentials(),
      authorization: { status: "required" },
    });

    await using app = await gatewayProcess({
      entry,
      environment: files.environment,
      upstream: { id: "test", transport: "http", url: upstream.url, auth: { type: "oauth" } },
    });

    await rejectionOf(app.client.connect(app.transport, { timeout: 4_000 }));

    expect(await app.closed).toEqual({ code: 1, signal: null });
    expect(app.stderr).toContain("cmg login");
    expect(upstream.requests).toEqual([]);
  }, 10_000);

  test("revoked authorization becomes a public tool failure without leaking OAuth response text", async () => {
    await using upstream = await oauthFixture({
      refresh: async () =>
        Response.json(
          { error: "invalid_grant", error_description: "private revoke detail" },
          { status: 400 },
        ),
    });

    await using files = await credentialFiles(upstream.credentials());

    await using app = await gatewayProcess({
      entry,
      environment: files.environment,
      upstream: { id: "test", transport: "http", url: upstream.url, auth: { type: "oauth" } },
    });

    await app.client.connect(app.transport, { timeout: 4_000 });
    upstream.rejectAccess();

    const result = await app.client.callTool({
      name: "execute",
      arguments: { code: "return await tools.add({ a: 2, b: 3 });" },
    });

    expect(result.structuredContent).toMatchObject({
      result: { ok: false, error: { kind: "script" } },
    });
    expect(JSON.stringify(result.structuredContent)).toContain("cmg login");
    expect(JSON.stringify(result)).not.toContain("private revoke detail");
    expect(app.stderr).not.toContain("private revoke detail");
    expect(upstream.refreshes).toBe(1);
  }, 10_000);
});
