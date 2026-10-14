import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { login, logout, Credentials, type CredentialStore } from "codemode-mcp-gateway";
import { memoryCredentials, oauthFixture } from "./support/oauth.ts";
import { rejectionOf } from "./support/rejection.ts";
// The OS adapter's service injection is internal; exercise it through login/logout without keychain access.
import { credentialStore } from "../src/auth/credentials.ts";

async function configuration(url: string, id = "notes") {
  const directory = await mkdtemp(join(tmpdir(), "cmg-login-"));
  const path = join(directory, "config.json");
  await Bun.write(
    path,
    JSON.stringify({
      upstream: { id, transport: "http", url, auth: { type: "oauth", scope: "read" } },
    }),
  );

  return {
    path,
    lockDirectory: join(directory, "locks"),
    [Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true }),
  };
}

describe("login and logout", () => {
  test("uses advertised discovery and PKCE, requesting only the chosen scope and reusing registration", async () => {
    await using upstream = await oauthFixture();
    await using config = await configuration(upstream.url);
    const memory = memoryCredentials();

    const options = {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
      authorize: async (url: URL) => {
        expect(url.searchParams.get("scope")).toBe("read offline_access");
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        await fetch(await upstream.authorize(url));
      },
    };

    expect(await login(config.path, options)).toEqual({ ok: true, value: undefined });
    const saved = Credentials.parse(memory.record);
    expect(saved.authorization).toMatchObject({
      status: "authorized",
      tokens: { access_token: "access-1" },
    });
    expect(await login(config.path, options)).toEqual({ ok: true, value: undefined });

    expect(memory.record?.redirectUri).toBe(saved.redirectUri);
    expect(upstream.registrations).toBe(1);
    expect(upstream.exchanges).toBe(2);
    expect(upstream.requests.some((request) => request.path === "/metadata")).toBe(true);
    expect(
      upstream.requests
        .filter((request) => request.path !== "/mcp")
        .every((request) => !request.headers.has("authorization")),
    ).toBe(true);
  });

  test("logout removes only the selected id and URL from the scoped credential service", async () => {
    await using notes = await oauthFixture();
    await using calendar = await oauthFixture();
    await using personal = await configuration(notes.url, "personal");
    await using work = await configuration(notes.url, "work");
    await using other = await configuration(calendar.url, "personal");
    const entries = new Map<string, string>();

    const service = {
      get: async (key: { service: string; name: string }) =>
        entries.get(key.service + ":" + key.name) ?? null,
      set: async (key: { service: string; name: string; value: string }) => {
        entries.set(key.service + ":" + key.name, key.value);
      },
      delete: async (key: { service: string; name: string }) =>
        entries.delete(key.service + ":" + key.name),
    };

    const store = (connection: Parameters<typeof credentialStore>[0]) =>
      credentialStore(connection, service);

    for (const [config, upstream] of [
      [personal, notes],
      [work, notes],
      [other, calendar],
    ] as const) {
      expect(
        await login(config.path, {
          store,
          lockDirectory: personal.lockDirectory,
          authorize: async (url) => {
            await fetch(await upstream.authorize(url));
          },
        }),
      ).toMatchObject({ ok: true });
    }

    expect(entries.size).toBe(3);
    expect(
      await logout(personal.path, { store, lockDirectory: personal.lockDirectory }),
    ).toMatchObject({ ok: true });
    expect(await store({ id: "personal", url: notes.url }).load()).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await store({ id: "work", url: notes.url }).load()).toMatchObject({
      ok: true,
      value: { authorization: { status: "authorized" } },
    });
    expect(await store({ id: "personal", url: calendar.url }).load()).toMatchObject({
      ok: true,
      value: { authorization: { status: "authorized" } },
    });
    expect(entries.size).toBe(2);
  });

  test.each(["malformed JSON", "unknown version", "another upstream"])(
    "rejects stored %s before contacting the provider",
    async (invalid) => {
      await using upstream = await oauthFixture();
      await using config = await configuration(upstream.url);
      const record = upstream.credentials();

      const stored =
        invalid === "malformed JSON"
          ? "private-malformed-credential"
          : JSON.stringify({
              ...record,
              version: invalid === "unknown version" ? 2 : 1,
              upstreamUrl:
                invalid === "another upstream" ? "https://other.example/mcp" : upstream.url,
            });

      const result = await login(config.path, {
        lockDirectory: config.lockDirectory,
        store: (connection) =>
          credentialStore(connection, {
            get: async () => stored,
            set: async () => {
              throw new Error("Unexpected credential write");
            },
            delete: async () => false,
          }),
      });

      expect(result).toMatchObject({ ok: false, error: { kind: "invalid" } });
      if (!result.ok) {
        expect(result.error.message).not.toContain("access-0");
        expect(result.error.message).not.toContain("refresh-0");
        expect(result.error.message).not.toContain("private-malformed-credential");
      }

      expect(upstream.requests).toEqual([]);
    },
  );

  test("reports failed credential persistence without exposing service diagnostics", async () => {
    await using upstream = await oauthFixture();
    await using config = await configuration(upstream.url);

    const result = await login(config.path, {
      lockDirectory: config.lockDirectory,
      store: (connection) =>
        credentialStore(connection, {
          get: async () => null,
          set: async () => {
            throw new Error("private keychain detail");
          },
          delete: async () => false,
        }),
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "storage" } });
    if (!result.ok) expect(result.error.message).not.toContain("private keychain detail");

    expect(upstream.exchanges).toBe(0);
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

    await using config = await configuration(upstream.url);
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

    await using config = await configuration(upstream.url);
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

    await using config = await configuration(upstream.url);
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
        error: { kind: "cancelled", message: "OAuth login timed out. Run cmg login again." },
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
    await using config = await configuration(upstream.url);
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
    await using config = await configuration(upstream.url);
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
    await using config = await configuration(upstream.url);
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

  test("logout during consent prevents the pending login from restoring credentials", async () => {
    await using upstream = await oauthFixture();
    await using config = await configuration(upstream.url);
    const memory = memoryCredentials();
    const options = { store: () => memory.store, lockDirectory: config.lockDirectory };

    const result = await login(config.path, {
      ...options,
      authorize: async (url) => {
        expect(await logout(config.path, options)).toMatchObject({ ok: true });
        await fetch(await upstream.authorize(url));
      },
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "required" } });
    expect(memory.record).toBeUndefined();
  });

  test("presentation failure closes the callback and keeps browser diagnostics private", async () => {
    await using upstream = await oauthFixture();
    await using config = await configuration(upstream.url);
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

  test("ignores unrelated callback requests and accepts the matching state exactly once", async () => {
    await using upstream = await oauthFixture();
    await using config = await configuration(upstream.url);
    const memory = memoryCredentials();

    const result = await login(config.path, {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
      authorize: async (url) => {
        const callback = await upstream.authorize(url);
        const unrelated = await fetch(callback, { method: "POST" });
        expect(unrelated.status).toBe(404);
        expect(unrelated.headers.get("cache-control")).toBe("no-store");
        expect(unrelated.headers.get("referrer-policy")).toBe("no-referrer");
        expect((await fetch(new URL("/other", callback))).status).toBe(404);
        expect((await fetch(callback, { headers: { Host: "example.com" } })).status).toBe(404);
        const state = callback.searchParams.get("state");
        if (state === null) throw new Error("Missing callback state");

        const wrong = new URL(callback);
        wrong.searchParams.set("state", (state[0] === "a" ? "b" : "a") + state.slice(1));
        expect((await fetch(wrong)).status).toBe(400);
        const duplicate = new URL(callback);
        duplicate.searchParams.append("state", state);
        expect((await fetch(duplicate)).status).toBe(400);
        expect(upstream.exchanges).toBe(0);
        expect((await fetch(callback)).status).toBe(200);
        expect((await fetch(callback)).status).toBe(409);
      },
    });

    expect(result).toEqual({ ok: true, value: undefined });
    expect(upstream.exchanges).toBe(1);
  });

  test.each([
    { name: "duplicate parameter", parameters: "code=synthetic-code&code=other" },
    { name: "empty code", parameters: "code=" },
    { name: "missing result", parameters: "" },
    { name: "code and error", parameters: "code=synthetic-code&error=access_denied" },
    { name: "mismatched issuer", parameters: "code=synthetic-code&iss=https://wrong.example/" },
  ])("rejects a callback with $name before exchanging tokens", async ({ parameters }) => {
    await using upstream = await oauthFixture();
    await using config = await configuration(upstream.url);
    const memory = memoryCredentials();

    const result = await login(config.path, {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
      authorize: async (url) => {
        const callback = await upstream.authorize(url);
        callback.searchParams.delete("code");
        if (parameters.includes("iss=")) callback.searchParams.delete("iss");

        for (const [name, value] of new URLSearchParams(parameters))
          callback.searchParams.append(name, value);

        expect((await fetch(callback)).status).toBe(200);
      },
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "invalid" } });
    expect(upstream.exchanges).toBe(0);
    expect(memory.record?.authorization).toEqual({ status: "required" });
  });

  test("denied consent preserves registration after well-known discovery fallback", async () => {
    await using upstream = await oauthFixture({ deny: true, challenge: false });
    await using config = await configuration(upstream.url);
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
    await using config = await configuration(upstream.url);
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

  test.each(["insecure metadata URL", "foreign resource"])(
    "rejects discovery with %s before presenting authorization",
    async (invalid) => {
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
                "WWW-Authenticate": `Bearer resource_metadata="${invalid === "insecure metadata URL" ? "http://insecure.example/metadata" : new URL("/metadata", url).href}"`,
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

      await using config = await configuration(new URL("/mcp", server.url).href);
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
      if (invalid === "insecure metadata URL") expect(paths).toEqual(["/mcp"]);
    },
  );

  test("does not follow a token-endpoint redirect carrying authorization credentials", async () => {
    await using upstream = await oauthFixture({
      auth: async (request) =>
        new URL(request.url).pathname === "/token"
          ? Response.redirect(new URL("/credential-sink", request.url).href, 307)
          : undefined,
    });

    await using config = await configuration(upstream.url);
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
