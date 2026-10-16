import { describe, expect, spyOn, test } from "bun:test";
import { secrets } from "bun";
import { login, logout, Credentials, type CredentialStore } from "codemode-mcp-gateway";
import { configuration } from "./support/configuration.ts";
import { memoryCredentials, oauthFixture } from "./support/oauth.ts";
import { rejectionOf } from "./support/rejection.ts";

describe("login", () => {
  test.each([
    ["zero", 0],
    ["fractional", 1.5],
    ["overflowing", 2 ** 31],
  ] as const)("rejects a %s deadline before reading configuration", async (_name, timeoutMs) => {
    const result = await login("missing-configuration.json", { timeoutMs });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid",
        message: "OAuth login timeout must be a positive timer-sized integer.",
      },
    });
  });

  test("uses advertised discovery and PKCE with only the requested scope", async () => {
    await using upstream = await oauthFixture();

    await using config = await configuration({
      type: "remote",
      url: upstream.url,
      oauth: { scope: "read" },
    });

    const memory = memoryCredentials();
    const presented: URL[] = [];

    const options = {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
      authorize: async (url: URL) => {
        presented.push(url);
        await fetch(await upstream.authorize(url));
      },
    };

    const result = await login(config.path, options);
    const saved = Credentials.parse(memory.record);

    expect(result).toEqual({ ok: true, value: undefined });
    expect(presented).toHaveLength(1);
    expect(presented[0]?.searchParams.get("scope")).toBe("read offline_access");
    expect(presented[0]?.searchParams.get("code_challenge_method")).toBe("S256");
    expect(saved.authorization).toMatchObject({
      status: "authorized",
      tokens: { access_token: "access-1" },
    });
    expect(upstream.registrations).toBe(1);
    expect(upstream.exchanges).toBe(1);
    expect(upstream.requests.some((request) => request.path === "/metadata")).toBe(true);
    expect(
      upstream.requests
        .filter((request) => request.path !== "/mcp")
        .every((request) => !request.headers.has("authorization")),
    ).toBe(true);
  });

  test("reuses registration and its callback URI on a later login", async () => {
    await using upstream = await oauthFixture();

    await using config = await configuration({
      type: "remote",
      url: upstream.url,
      oauth: { scope: "read" },
    });

    const memory = memoryCredentials();

    const options = {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
      authorize: async (url: URL) => {
        await fetch(await upstream.authorize(url));
      },
    };

    expect(await login(config.path, options)).toEqual({ ok: true, value: undefined });
    const saved = Credentials.parse(memory.record);

    const result = await login(config.path, options);

    expect(result).toEqual({ ok: true, value: undefined });
    expect(memory.record?.redirectUri).toBe(saved.redirectUri);
    expect(upstream.registrations).toBe(1);
    expect(upstream.exchanges).toBe(2);
  });

  test.each([
    { name: "malformed JSON", stored: () => "private-malformed-credential" },
    {
      name: "unknown version",
      stored: (record: Credentials) => JSON.stringify({ ...record, version: 2 }),
    },
    {
      name: "another upstream",
      stored: (record: Credentials) =>
        JSON.stringify({ ...record, upstreamUrl: "https://other.example/mcp" }),
    },
  ])("rejects stored $name before contacting the provider", async ({ stored }) => {
    await using upstream = await oauthFixture();

    await using config = await configuration({
      type: "remote",
      url: upstream.url,
      oauth: { scope: "read" },
    });

    using read = spyOn(secrets, "get").mockResolvedValue(stored(upstream.credentials()));

    using write = spyOn(secrets, "set").mockRejectedValue(new Error("Unexpected credential write"));

    using remove = spyOn(secrets, "delete").mockResolvedValue(false);

    const result = await login(config.path, { lockDirectory: config.lockDirectory });

    expect(result).toMatchObject({ ok: false, error: { kind: "invalid" } });
    if (!result.ok) {
      expect(result.error.message).not.toContain("access-0");
      expect(result.error.message).not.toContain("refresh-0");
      expect(result.error.message).not.toContain("private-malformed-credential");
    }

    expect(upstream.requests).toEqual([]);
    expect(read).toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  test("reports failed credential persistence without exposing service diagnostics", async () => {
    await using upstream = await oauthFixture();

    await using config = await configuration({
      type: "remote",
      url: upstream.url,
      oauth: { scope: "read" },
    });

    using read = spyOn(secrets, "get").mockResolvedValue(null);
    using write = spyOn(secrets, "set").mockRejectedValue(new Error("private keychain detail"));
    using remove = spyOn(secrets, "delete").mockResolvedValue(false);

    const result = await login(config.path, { lockDirectory: config.lockDirectory });

    expect(result).toMatchObject({ ok: false, error: { kind: "storage" } });
    if (!result.ok) expect(result.error.message).not.toContain("private keychain detail");

    expect(upstream.exchanges).toBe(0);
    expect(read).toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
  });

  test("a rejected client is removed so a later login can register again", async () => {
    let reject = true;

    await using upstream = await oauthFixture({
      auth: async (request) =>
        new URL(request.url).pathname === "/token" && reject
          ? Response.json(
              { error: "invalid_client", error_description: "private client detail" },
              { status: 400 },
            )
          : undefined,
    });

    await using config = await configuration({
      type: "remote",
      url: upstream.url,
      oauth: { scope: "read" },
    });

    const memory = memoryCredentials();

    const options = {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
      authorize: async (url: URL) => {
        await fetch(await upstream.authorize(url));
      },
    };

    const failed = await login(config.path, options);
    expect(failed).toMatchObject({ ok: false, error: { kind: "required" } });
    if (!failed.ok) expect(failed.error.message).not.toContain("private client detail");

    expect(memory.record).toBeUndefined();
    reject = false;

    expect(await login(config.path, options)).toEqual({ ok: true, value: undefined });
    expect(upstream.registrations).toBe(2);
    expect(memory.record?.authorization.status).toBe("authorized");
  });

  test("rejected-client cleanup cannot delete a grant replaced during consent", async () => {
    await using upstream = await oauthFixture({
      auth: async (request) =>
        new URL(request.url).pathname === "/token"
          ? Response.json({ error: "unauthorized_client" }, { status: 400 })
          : undefined,
    });

    await using config = await configuration({
      type: "remote",
      url: upstream.url,
      oauth: { scope: "read" },
    });

    const memory = memoryCredentials();
    const replacement = upstream.credentials();

    const result = await login(config.path, {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
      authorize: async (url) => {
        await memory.store.save(replacement);
        await fetch(await upstream.authorize(url));
      },
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "required" } });
    expect(memory.record).toEqual(replacement);
  });

  test.each([
    { name: "discovery", path: "/metadata" },
    { name: "registration", path: "/register" },
    { name: "code exchange", path: "/token" },
  ])("the shared login deadline cancels stalled $name and releases ownership", async ({ path }) => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    await using upstream = await oauthFixture({
      auth: async (request) => {
        if (new URL(request.url).pathname === path) {
          started.resolve();
          await release.promise;
        }

        return undefined;
      },
    });

    await using config = await configuration({
      type: "remote",
      url: upstream.url,
      oauth: { scope: "read" },
    });

    const memory = memoryCredentials();
    const options = { store: () => memory.store, lockDirectory: config.lockDirectory };
    let callback: URL | undefined;

    const pending = login(config.path, {
      ...options,
      timeoutMs: 500,
      authorize: async (url) => {
        callback = await upstream.authorize(url);
        await fetch(callback);
      },
    });

    try {
      await started.promise;
      expect(await pending).toMatchObject({
        ok: false,
        error: { kind: "cancelled", message: "OAuth login timed out. Run gw login again." },
      });
      expect(memory.record?.authorization.status).not.toBe("authorized");
      if (callback !== undefined)
        expect((await rejectionOf(fetch(callback))).reason).toBeInstanceOf(TypeError);

      expect(await logout(config.path, options)).toMatchObject({ ok: true });
    } finally {
      release.resolve();
      await pending;
    }
  });

  test("the deadline also bounds waiting for another credential operation", async () => {
    await using upstream = await oauthFixture();

    await using config = await configuration({
      type: "remote",
      url: upstream.url,
      oauth: { scope: "read" },
    });

    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const memory = memoryCredentials();

    const removing = logout(config.path, {
      lockDirectory: config.lockDirectory,
      store: () => ({
        ...memory.store,
        clear: async () => {
          started.resolve();
          await release.promise;

          return memory.store.clear();
        },
      }),
    });

    try {
      await started.promise;
      expect(
        await login(config.path, {
          lockDirectory: config.lockDirectory,
          store: () => memory.store,
          timeoutMs: 100,
        }),
      ).toMatchObject({ ok: false, error: { kind: "cancelled" } });
      expect(upstream.requests).toEqual([]);
    } finally {
      release.resolve();
      await removing;
    }
  });

  test("the deadline closes the callback even while browser presentation is pending", async () => {
    await using upstream = await oauthFixture();

    await using config = await configuration({
      type: "remote",
      url: upstream.url,
      oauth: { scope: "read" },
    });

    const memory = memoryCredentials();
    const release = Promise.withResolvers<void>();
    let callback: URL | undefined;

    const pending = login(config.path, {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
      timeoutMs: 500,
      authorize: async (url) => {
        callback = await upstream.authorize(url);
        await release.promise;
      },
    });

    try {
      expect(await pending).toMatchObject({ ok: false, error: { kind: "cancelled" } });
      if (callback === undefined) throw new Error("No callback captured");

      expect((await rejectionOf(fetch(callback))).reason).toBeInstanceOf(TypeError);
      expect(upstream.exchanges).toBe(0);
    } finally {
      release.resolve();
      await pending;
    }
  });

  test("does not publish success or release credential ownership before the completed grant is saved", async () => {
    await using upstream = await oauthFixture();

    await using config = await configuration({
      type: "remote",
      url: upstream.url,
      oauth: { scope: "read" },
    });

    const memory = memoryCredentials();
    const saving = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const store = {
      ...memory.store,
      async save(record) {
        if (record.authorization.status === "authorized") {
          saving.resolve();
          await release.promise;
        }

        return memory.store.save(record);
      },
    } satisfies CredentialStore;

    const options = { store: () => store, lockDirectory: config.lockDirectory };
    let published = false;

    const pending = login(config.path, {
      ...options,
      authorize: async (url) => {
        await fetch(await upstream.authorize(url));
      },
    }).then((result) => {
      published = true;

      return result;
    });

    try {
      await saving.promise;
      expect(await login(config.path, { ...options, timeoutMs: 100 })).toMatchObject({
        ok: false,
        error: { kind: "cancelled" },
      });
      expect(published).toBe(false);
      expect(memory.record?.authorization.status).toBe("required");
    } finally {
      release.resolve();
      await pending;
    }

    expect(await pending).toEqual({ ok: true, value: undefined });
    expect(memory.record?.authorization.status).toBe("authorized");
    expect(await logout(config.path, options)).toMatchObject({ ok: true });
  });

  test("presentation failure closes the callback and keeps browser diagnostics private", async () => {
    await using upstream = await oauthFixture();

    await using config = await configuration({
      type: "remote",
      url: upstream.url,
      oauth: { scope: "read" },
    });

    const memory = memoryCredentials();
    const options = { store: () => memory.store, lockDirectory: config.lockDirectory };
    let callback: URL | undefined;

    const result = await login(config.path, {
      ...options,
      authorize: async (url) => {
        callback = await upstream.authorize(url);
        throw new Error("private browser detail");
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "unavailable", message: "Could not present the OAuth authorization URL." },
    });
    if (callback === undefined) throw new Error("No callback captured");

    expect((await rejectionOf(fetch(callback))).reason).toBeInstanceOf(TypeError);
    expect(upstream.exchanges).toBe(0);
    expect(await logout(config.path, options)).toMatchObject({ ok: true });
  });

  test("denied consent preserves registration after well-known discovery fallback", async () => {
    await using upstream = await oauthFixture({ deny: true, challenge: false });

    await using config = await configuration({
      type: "remote",
      url: upstream.url,
      oauth: { scope: "read" },
    });

    const memory = memoryCredentials();

    const result = await login(config.path, {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
      authorize: async (url) => {
        await fetch(await upstream.authorize(url));
      },
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "denied" } });
    expect(upstream.exchanges).toBe(0);
    expect(memory.record?.authorization).toEqual({ status: "required" });
    expect(
      upstream.requests.some((request) =>
        request.path.startsWith("/.well-known/oauth-protected-resource"),
      ),
    ).toBe(true);
  });

  test("caller cancellation closes the callback and releases credential ownership", async () => {
    await using upstream = await oauthFixture();

    await using config = await configuration({
      type: "remote",
      url: upstream.url,
      oauth: { scope: "read" },
    });

    const memory = memoryCredentials();
    const abort = new AbortController();
    let callback: URL | undefined;
    const options = { store: () => memory.store, lockDirectory: config.lockDirectory };

    const result = await login(config.path, {
      ...options,
      signal: abort.signal,
      authorize: async (url) => {
        callback = await upstream.authorize(url);
        abort.abort();
      },
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "cancelled" } });
    if (callback === undefined) throw new Error("No callback captured");

    expect((await rejectionOf(fetch(callback))).reason).toBeInstanceOf(TypeError);
    expect(await logout(config.path, options)).toMatchObject({ ok: true });
  });

  test("rejects an insecure metadata URL before fetching it or presenting authorization", async () => {
    const paths: string[] = [];

    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        paths.push(new URL(request.url).pathname);

        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Bearer resource_metadata="http://insecure.example/metadata"',
          },
        });
      },
    });

    await using config = await configuration({
      type: "remote",
      url: new URL("/mcp", server.url).href,
      oauth: { scope: "read" },
    });

    const memory = memoryCredentials();
    let presented = false;

    const result = await login(config.path, {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
      authorize: async () => {
        presented = true;
      },
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "invalid" } });
    expect(presented).toBe(false);
    expect(memory.writes).toBe(0);
    expect(paths).toEqual(["/mcp"]);
  });

  test("rejects metadata for a foreign resource before presenting authorization", async () => {
    const paths: string[] = [];

    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        paths.push(url.pathname);
        if (url.pathname === "/mcp")
          return new Response(null, {
            status: 401,
            headers: {
              "WWW-Authenticate": `Bearer resource_metadata="${new URL("/metadata", url).href}"`,
            },
          });

        if (url.pathname === "/metadata")
          return Response.json({
            resource: "https://other.example/mcp",
            authorization_servers: [new URL("/", url).href],
          });

        if (url.pathname === "/.well-known/oauth-authorization-server")
          return Response.json({
            issuer: new URL("/", url).href,
            authorization_endpoint: new URL("/authorize", url).href,
            token_endpoint: new URL("/token", url).href,
            response_types_supported: ["code"],
          });

        return new Response(null, { status: 404 });
      },
    });

    await using config = await configuration({
      type: "remote",
      url: new URL("/mcp", server.url).href,
      oauth: { scope: "read" },
    });

    const memory = memoryCredentials();
    let presented = false;

    const result = await login(config.path, {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
      authorize: async () => {
        presented = true;
      },
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "invalid" } });
    expect(presented).toBe(false);
    expect(memory.writes).toBe(0);
    expect(paths).not.toContain("/token");
  });

  test("does not follow a token-endpoint redirect carrying authorization credentials", async () => {
    await using upstream = await oauthFixture({
      auth: async (request) =>
        new URL(request.url).pathname === "/token"
          ? Response.redirect(new URL("/credential-sink", request.url).href, 307)
          : undefined,
    });

    await using config = await configuration({
      type: "remote",
      url: upstream.url,
      oauth: { scope: "read" },
    });

    const memory = memoryCredentials();

    const result = await login(config.path, {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
      authorize: async (url) => {
        await fetch(await upstream.authorize(url));
      },
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "unavailable" } });
    expect(upstream.requests.some((request) => request.path === "/credential-sink")).toBe(false);
    expect(memory.record?.authorization).toEqual({ status: "required" });
  });
});
