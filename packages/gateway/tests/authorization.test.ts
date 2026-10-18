import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, rename, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { login, logout, Credentials, type CredentialStore } from "codemode-mcp-gateway";
import { gatewayProcess } from "./support/gateway-process.ts";
import { oauthFixture } from "./support/oauth.ts";
import { rejectionOf } from "./support/rejection.ts";
import { responseText, responseValue } from "./support/output.ts";

async function credentialFiles(value: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "cmg-auth-process-"));
  const path = join(directory, "credentials.json");
  if (value !== undefined) await Bun.write(path, JSON.stringify(value));

  const store = {
    async load() {
      return {
        ok: true,
        value: (await Bun.file(path).exists())
          ? Credentials.parse(await Bun.file(path).json())
          : undefined,
      };
    },
    async save(record) {
      await Bun.write(path + ".login", JSON.stringify(record));
      await rename(path + ".login", path);

      return { ok: true, value: undefined };
    },
    async clear() {
      await Bun.file(path).delete();

      return { ok: true, value: undefined };
    },
  } satisfies CredentialStore;

  return {
    environment: { CMG_TEST_CREDENTIALS: path, CMG_TEST_LOCKS: join(directory, "locks") },
    path,
    store,
    [Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true }),
  };
}

const entry = fileURLToPath(new URL("./fixtures/oauth-gateway.ts", import.meta.url));

describe("OAuth-backed stdio gateway", () => {
  test("a running named gateway adopts credentials saved by login in another process", async () => {
    await using upstream = await oauthFixture();
    await using files = await credentialFiles(undefined);

    await using app = await gatewayProcess({
      entry,
      environment: files.environment,
      configuration: {
        mcp: { servers: { notes: { type: "remote", url: upstream.url, oauth: {} } } },
      },
    });

    await app.client.connect(app.transport, { timeout: 4_000 });
    await app.waitFor('"state":"needs-auth"');
    const pid = app.child.pid;

    expect(
      await login(app.config, {
        server: "notes",
        store: () => files.store,
        lockDirectory: files.environment.CMG_TEST_LOCKS,
        authorize: async (url) => {
          await fetch(await upstream.authorize(url));
        },
      }),
    ).toEqual({ ok: true, value: undefined });
    await app.waitFor('"state":"connected"');

    const response = await app.client.callTool({
      name: "execute",
      arguments: {
        code: 'return (await tools["notes.add"]({ a: 20, b: 22 })).structuredContent.sum;',
      },
    });

    app.child.stdin.end();

    expect(responseValue(response)).toBe(42);
    expect(app.child.pid).toBe(pid);
    expect(await app.closed).toEqual({ code: 0, signal: null });
    expect(app.stderr).not.toContain("access-");
    expect(app.stderr).not.toContain("refresh-");
  }, 10_000);

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
      upstream: { type: "remote", url: upstream.url, oauth: {} },
    } as const;

    await using first = await gatewayProcess(options);
    await using second = await gatewayProcess(options);

    await Promise.all([
      first.client.connect(first.transport, { timeout: 4_000 }),
      second.client.connect(second.transport, { timeout: 4_000 }),
    ]);
    await Promise.all([first.waitForConnections(1), second.waitForConnections(1)]);
    connected = true;
    upstream.rejectAccess();

    const input = {
      name: "execute",
      arguments: {
        code: 'return (await tools["test.add"]({ a: 2, b: 3 })).structuredContent.sum;',
      },
    };

    const requests = Promise.all([first.client.callTool(input), second.client.callTool(input)]);
    try {
      await Promise.all([refreshing.promise, challenged.promise]);
      expect(upstream.refreshes).toBe(1);
    } finally {
      release.resolve();
    }

    for (const result of await requests) {
      expect(responseValue(result)).toBe(5);
    }

    expect(upstream.refreshes).toBe(1);
    expect(await Bun.file(files.path).json()).toMatchObject({
      authorization: { tokens: { refresh_token: "refresh-1" } },
    });
    first.child.stdin.end();
    second.child.stdin.end();
    expect(await first.closed).toEqual({ code: 0, signal: null });
    expect(await second.closed).toEqual({ code: 0, signal: null });
    expect(upstream.requests.filter((request) => request.method === "DELETE")).toHaveLength(2);
    expect(first.stderr + second.stderr).not.toContain("access-");
    expect(first.stderr + second.stderr).not.toContain("refresh-");
  }, 10_000);

  test("logout waits for an active refresh and its completed rotation cannot restore authorization", async () => {
    const refreshing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    await using upstream = await oauthFixture({
      refresh: async () => {
        refreshing.resolve();
        await release.promise;

        return undefined;
      },
    });

    await using files = await credentialFiles(upstream.credentials());

    await using app = await gatewayProcess({
      entry,
      environment: files.environment,
      upstream: { type: "remote", url: upstream.url, oauth: {} },
    });

    await app.client.connect(app.transport, { timeout: 4_000 });
    await app.waitFor('"state":"connected"');
    upstream.rejectAccess();

    const pending = app.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools["test.add"]({ a: 2, b: 3 });' },
    });

    await refreshing.promise;

    const removing = Bun.spawn(
      [
        process.execPath,
        "--conditions=development",
        entry,
        "auth",
        "logout",
        "--config",
        app.config,
      ],
      {
        env: { ...process.env, ...files.environment },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 4_000,
      },
    );

    try {
      // A competing public login confirms the refresh still owns the shared lock.
      expect(
        await login(app.config, {
          store: () => files.store,
          lockDirectory: files.environment.CMG_TEST_LOCKS,
          timeoutMs: 100,
        }),
      ).toMatchObject({ ok: false, error: { kind: "cancelled" } });
      expect(await Bun.file(files.path).exists()).toBe(true);
    } finally {
      release.resolve();
      await pending;
    }

    expect(await removing.exited).toBe(0);
    expect(await new Response(removing.stdout).text()).toContain(
      "does not revoke the upstream grant",
    );
    expect(await new Response(removing.stderr).text()).toBe("");
    expect(await Bun.file(files.path).exists()).toBe(false);

    const response = await app.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools["test.add"]({ a: 2, b: 3 });' },
    });

    expect(response.isError).toBe(true);
    expect(responseText(response)).toContain("gw auth login");
    expect(upstream.refreshes).toBe(1);
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
      upstream: { type: "remote", url: upstream.url, oauth: {} },
    });

    await app.client.connect(app.transport, { timeout: 4_000 });
    await app.waitFor('"state":"connected"');

    const result = await app.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools["test.add"]({ a: 2, b: 3 });' },
    });

    expect(result.isError).toBe(true);
    expect(responseText(result)).toContain("scope");
    expect(JSON.stringify(result)).not.toContain("private scope detail");
    expect(upstream.refreshes).toBe(0);
    expect(upstream.registrations).toBe(0);
    expect(upstream.requests.some((request) => request.path === "/authorize")).toBe(false);
  }, 10_000);

  test("unexpected credential-store exceptions remain private at the CLI boundary", async () => {
    await using upstream = await oauthFixture();
    await using files = await credentialFiles(upstream.credentials());

    await Bun.write(files.path, "private-malformed-credential-data");

    await using app = await gatewayProcess({
      entry,
      environment: files.environment,
      upstream: { type: "remote", url: upstream.url, oauth: {} },
    });

    // Named serving may complete its agent handshake before setup fails.
    expect(await app.closed).toEqual({ code: 1, signal: null });
    expect(app.stderr).toContain("Private diagnostics were not displayed");
    expect(app.stderr).not.toContain("private-malformed-credential-data");
  }, 10_000);

  test("EOF exits cleanly when session deletion would require token refresh", async () => {
    await using upstream = await oauthFixture();
    await using files = await credentialFiles(upstream.credentials());

    await using app = await gatewayProcess({
      entry,
      environment: files.environment,
      upstream: { type: "remote", url: upstream.url, oauth: {} },
    });

    await app.client.connect(app.transport, { timeout: 4_000 });
    await app.waitFor('"state":"connected"');
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
      upstream: { type: "remote", url: upstream.url, oauth: {} },
    });

    await app.client.connect(app.transport, { timeout: 4_000 });
    await app.waitFor('"state":"connected"');
    upstream.rejectAccess();

    const request = rejectionOf(
      app.client.callTool({
        name: "execute",
        arguments: { code: 'return await tools["test.add"]({ a: 2, b: 3 });' },
      }),
    );

    try {
      await started.promise;
      app.child.kill("SIGTERM");
      await request;

      expect(await app.closed).toEqual({ code: 143, signal: null });
      expect(await Bun.file(files.path).json()).toEqual(credentials);
      expect(upstream.refreshes).toBe(1);
      expect(upstream.requests.some((request) => request.method === "DELETE")).toBe(false);
      expect(app.stderr).not.toContain("OAuth operation was cancelled");
    } finally {
      release.resolve();
    }
  }, 10_000);

  test("missing authorization leaves discovery available without dispatching to upstream", async () => {
    await using upstream = await oauthFixture();

    await using files = await credentialFiles({
      ...upstream.credentials(),
      authorization: { status: "required" },
    });

    await using app = await gatewayProcess({
      entry,
      environment: files.environment,
      upstream: { type: "remote", url: upstream.url, oauth: {} },
    });

    await app.client.connect(app.transport, { timeout: 4_000 });
    await app.waitFor('"state":"needs-auth"');

    const status = await app.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools.searchTools({ query: "add" });' },
    });

    expect(responseValue(status)).toMatchObject({
      tools: [],
      servers: [{ name: "test", state: "needs-auth" }],
    });
    expect(app.stderr).toContain("gw auth login");
    expect(upstream.requests).toEqual([]);
    app.child.stdin.end();
    expect(await app.closed).toEqual({ code: 0, signal: null });
  }, 10_000);

  test("a revoked grant stays private, stops retries, and recovers in the same gateway after a new login", async () => {
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
      upstream: { type: "remote", url: upstream.url, oauth: {} },
    });

    await app.client.connect(app.transport, { timeout: 4_000 });
    await app.waitFor('"state":"connected"');
    upstream.rejectAccess();

    const result = await app.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools["test.add"]({ a: 2, b: 3 });' },
    });

    expect(result.isError).toBe(true);
    expect(responseText(result)).toContain("gw auth login");
    expect(JSON.stringify(result)).not.toContain("private revoke detail");
    expect(app.stderr).not.toContain("private revoke detail");
    expect(upstream.refreshes).toBe(1);
    expect(await Bun.file(files.path).json()).toMatchObject({
      client: { client_id: "cmg-test-client" },
      authorization: { status: "required" },
    });

    const input = {
      name: "execute",
      arguments: {
        code: 'return (await tools["test.add"]({ a: 2, b: 3 })).structuredContent.sum;',
      },
    };

    expect((await app.client.callTool(input)).isError).toBe(true);
    expect(upstream.refreshes).toBe(1);

    const options = { store: () => files.store, lockDirectory: files.environment.CMG_TEST_LOCKS };
    expect(await logout(app.config, options)).toMatchObject({ ok: true });
    expect(
      await login(app.config, {
        ...options,
        authorize: async (url) => {
          await fetch(await upstream.authorize(url));
        },
      }),
    ).toMatchObject({ ok: true });
    await app.waitFor('"state":"needs-auth"');
    // A new session adopts the login; wait for its second connection report.
    await app.waitForConnections(2);
    expect(responseValue(await app.client.callTool(input))).toBe(5);
    expect(upstream.refreshes).toBe(1);
    app.child.stdin.end();
    expect(await app.closed).toEqual({ code: 0, signal: null });
    expect(upstream.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
  }, 10_000);

  test.each(["rotation", "grant invalidation"])(
    "failed persistence of %s stops retries without publishing a token",
    async (scenario) => {
      await using upstream = await oauthFixture({
        refresh: async () =>
          scenario === "rotation"
            ? undefined
            : Response.json({ error: "invalid_grant" }, { status: 400 }),
      });

      const original = upstream.credentials();
      await using files = await credentialFiles(original);

      await using app = await gatewayProcess({
        entry,
        environment: { ...files.environment, CMG_TEST_SAVE_FAILURE: "true" },
        upstream: { type: "remote", url: upstream.url, oauth: {} },
      });

      await app.client.connect(app.transport, { timeout: 4_000 });
      await app.waitFor('"state":"connected"');
      upstream.rejectAccess();

      const input = {
        name: "execute",
        arguments: { code: 'return await tools["test.add"]({ a: 2, b: 3 });' },
      };

      const first = await app.client.callTool(input);
      expect(first.isError).toBe(true);
      expect(responseText(first)).toContain("authorization storage");
      expect((await app.client.callTool(input)).isError).toBe(true);
      expect(upstream.refreshes).toBe(1);
      expect(await Bun.file(files.path).json()).toEqual(original);
    },
    10_000,
  );

  test("an issuer change prevents serving with the saved grant", async () => {
    await using upstream = await oauthFixture();

    await using files = await credentialFiles({
      ...upstream.credentials(),
      issuer: "https://different.example/",
    });

    await using app = await gatewayProcess({
      entry,
      environment: files.environment,
      upstream: { type: "remote", url: upstream.url, oauth: {} },
    });

    await app.client.connect(app.transport, { timeout: 4_000 });
    await app.waitFor('"state":"needs-auth"');
    expect(app.stderr).toContain("authorization required");
    expect(upstream.refreshes).toBe(0);
    expect(upstream.requests.every((request) => !request.headers.has("authorization"))).toBe(true);
    app.child.stdin.end();
    expect(await app.closed).toEqual({ code: 0, signal: null });
  }, 10_000);

  test("a late challenge for an old token reuses the already rotated grant", async () => {
    const challenged = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let connected = false;
    let challenges = 0;

    await using upstream = await oauthFixture({
      unauthorized: async (request) => {
        if (connected && request.method === "POST" && ++challenges === 1) {
          challenged.resolve();
          await release.promise;
        }
      },
    });

    await using files = await credentialFiles(upstream.credentials());

    await using app = await gatewayProcess({
      entry,
      environment: files.environment,
      upstream: { type: "remote", url: upstream.url, oauth: {} },
    });

    await app.client.connect(app.transport, { timeout: 4_000 });
    await app.waitFor('"state":"connected"');
    connected = true;
    upstream.rejectAccess();

    const input = {
      name: "execute",
      arguments: {
        code: 'return (await tools["test.add"]({ a: 2, b: 3 })).structuredContent.sum;',
      },
    };

    const delayed = app.client.callTool(input);

    try {
      await challenged.promise;
      expect(responseValue(await app.client.callTool(input))).toBe(5);
      expect(upstream.refreshes).toBe(1);
    } finally {
      release.resolve();
    }

    expect(responseValue(await delayed)).toBe(5);
    expect(upstream.refreshes).toBe(1);
  }, 10_000);

  test("losing refresh ownership cancels HTTP work and prevents persistence or retry", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    await using upstream = await oauthFixture({
      refresh: async () => {
        started.resolve();
        await release.promise;

        return undefined;
      },
    });

    const original = upstream.credentials();
    await using files = await credentialFiles(original);

    await using app = await gatewayProcess({
      entry,
      environment: files.environment,
      upstream: { type: "remote", url: upstream.url, oauth: {} },
    });

    await app.client.connect(app.transport, { timeout: 4_000 });
    await app.waitFor('"state":"connected"');
    upstream.rejectAccess();

    const input = {
      name: "execute",
      arguments: { code: 'return await tools["test.add"]({ a: 2, b: 3 });' },
    };

    const pending = app.client.callTool(input);

    try {
      await started.promise;
      const locks = await readdir(files.environment.CMG_TEST_LOCKS);
      expect(locks).toHaveLength(1);
      const lock = locks[0];
      if (lock === undefined) throw new Error("Missing active credential lock");

      await rm(join(files.environment.CMG_TEST_LOCKS, lock), { recursive: true });
      const failed = await pending;
      expect(failed.isError).toBe(true);
      expect(responseText(failed)).toContain("authorization busy");
      expect((await app.client.callTool(input)).isError).toBe(true);
      expect(await Bun.file(files.path).json()).toEqual(original);
      expect(upstream.refreshes).toBe(1);
    } finally {
      release.resolve();
    }
  }, 10_000);
});
