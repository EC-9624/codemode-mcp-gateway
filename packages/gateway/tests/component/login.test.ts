import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { login, logout } from "../../src/auth/login.ts";
import { OAuthSession } from "../../src/auth/session.ts";
import { memoryCredentials, oauthFixture } from "../support/oauth.ts";
import { rejectionOf } from "../support/rejection.ts";
import { credentialStore, type CredentialStore } from "../../src/auth/credentials.ts";
import { acquireLease } from "../../src/auth/lease.ts";

async function configuration(url: string) {
  const directory = await mkdtemp(join(tmpdir(), "cmg-oauth-"));
  const path = join(directory, "config.json");
  await Bun.write(
    path,
    JSON.stringify({
      upstream: { id: "test", transport: "http", url, auth: { type: "oauth", scope: "read" } },
    }),
  );

  return {
    path,
    lockDirectory: join(directory, "locks"),
    [Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true }),
  };
}

describe("local OAuth login", () => {
  test("first login persists a normalized registration through the OS credential adapter", async () => {
    await using upstream = await oauthFixture();
    await using config = await configuration(upstream.url);

    let stored: string | null = null;

    const store = credentialStore(
      { id: "test", url: upstream.url },
      {
        get: async () => stored,
        set: async ({ value }) => {
          stored = value;
        },
        delete: async () => {
          stored = null;

          return true;
        },
      },
    );

    const result = await login(config.path, {
      store: () => store,
      lockDirectory: config.lockDirectory,
      authorize: async (url) => {
        await fetch(await upstream.authorize(url));
      },
    });

    expect(result).toEqual({ ok: true, value: undefined });
    expect(await store.load()).toMatchObject({
      ok: true,
      value: {
        client: { client_id: "cmg-test-client" },
        authorization: { status: "authorized", tokens: { access_token: "access-1" } },
      },
    });
    expect(upstream.registrations).toBe(1);
    expect(upstream.exchanges).toBe(1);
  });

  test.each(["invalid_client", "unauthorized_client"])(
    "a rejected %s registration is removed so the next login can recover",
    async (error) => {
      let reject = true;

      await using upstream = await oauthFixture({
        auth: async (request) => {
          if (new URL(request.url).pathname === "/token" && reject) {
            return Response.json(
              { error, error_description: "private client detail" },
              { status: 400 },
            );
          }

          return undefined;
        },
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
    },
  );

  test("rejected-client cleanup cannot remove a grant replaced during browser consent", async () => {
    await using upstream = await oauthFixture({
      auth: async (request) =>
        new URL(request.url).pathname === "/token"
          ? Response.json({ error: "invalid_client" }, { status: 400 })
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
    { name: "discovery", path: "/.well-known/oauth-protected-resource" },
    { name: "registration", path: "/register" },
    { name: "code exchange", path: "/token" },
  ])("the login deadline cancels stalled $name", async ({ path }) => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    await using upstream = await oauthFixture({
      auth: async (request) => {
        if (new URL(request.url).pathname.startsWith(path)) {
          started.resolve();
          await release.promise;
        }

        return undefined;
      },
    });

    await using config = await configuration(upstream.url);

    const memory = memoryCredentials();
    let callback: URL | undefined;

    const pending = login(config.path, {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
      timeoutMs: 300,
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
      if (callback !== undefined) {
        expect((await rejectionOf(fetch(callback))).reason).toBeInstanceOf(TypeError);
      }

      const acquired = await acquireLease({ id: "test", url: upstream.url }, config.lockDirectory, {
        waitMs: 0,
      });

      if (!acquired.ok) throw new Error(acquired.error.message);

      await using lease = acquired.value;

      expect(lease.check()).toEqual({ ok: true, value: undefined });
    } finally {
      release.resolve();
      await pending;
    }
  });

  test("the login deadline cancels credential-lock acquisition", async () => {
    await using upstream = await oauthFixture();
    await using config = await configuration(upstream.url);

    const acquired = await acquireLease({ id: "test", url: upstream.url }, config.lockDirectory);
    if (!acquired.ok) throw new Error(acquired.error.message);

    await using lease = acquired.value;

    const result = await login(config.path, {
      store: () => memoryCredentials().store,
      lockDirectory: config.lockDirectory,
      timeoutMs: 100,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "cancelled", message: "OAuth login timed out. Run cmg login again." },
    });
    expect(upstream.requests).toHaveLength(0);
    expect(lease.check()).toEqual({ ok: true, value: undefined });
  });

  test("the login deadline closes the callback while browser presentation is still pending", async () => {
    await using upstream = await oauthFixture();
    await using config = await configuration(upstream.url);

    const memory = memoryCredentials();
    const release = Promise.withResolvers<void>();
    let callback: URL | undefined;

    const pending = login(config.path, {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
      timeoutMs: 300,
      authorize: async (url) => {
        callback = await upstream.authorize(url);
        await release.promise;
      },
    });

    try {
      expect(await pending).toMatchObject({
        ok: false,
        error: { kind: "cancelled", message: "OAuth login timed out. Run cmg login again." },
      });
      if (callback === undefined) throw new Error("No callback captured");

      expect((await rejectionOf(fetch(callback))).reason).toBeInstanceOf(TypeError);
      expect(upstream.exchanges).toBe(0);
    } finally {
      release.resolve();
      await pending;
    }
  });

  test("logout waits for an active refresh and cannot be undone by its completion", async () => {
    const refreshing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    await using upstream = await oauthFixture({
      refresh: async () => {
        refreshing.resolve();
        await release.promise;

        return undefined;
      },
    });

    await using config = await configuration(upstream.url);

    const memory = memoryCredentials(upstream.credentials(Date.now() - 4_000_000));
    const connection = { id: "test", url: upstream.url };

    const opened = await OAuthSession.open(
      connection,
      memory.store,
      new AbortController().signal,
      config.lockDirectory,
    );

    if (!opened.ok) throw new Error(opened.error.message);

    await using session = opened.value;

    const pending = session.token();
    await refreshing.promise;

    const removing = logout(config.path, {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
    });

    try {
      expect(await acquireLease(connection, config.lockDirectory, { waitMs: 0 })).toMatchObject({
        ok: false,
        error: { kind: "busy" },
      });
      expect(memory.record?.authorization.status).toBe("authorized");
    } finally {
      release.resolve();
      await Promise.all([pending, removing]);
    }

    expect(await removing).toMatchObject({ ok: true });
    expect(memory.record).toBeUndefined();
    expect(await session.token()).toMatchObject({ ok: false, error: { kind: "required" } });
    expect(upstream.refreshes).toBe(1);
  });

  test("holds credential ownership until the completed grant is saved", async () => {
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

    const pending = login(config.path, {
      ...options,
      authorize: async (url) => {
        await fetch(await upstream.authorize(url));
      },
    });

    try {
      await saving.promise;
      expect(
        await acquireLease({ id: "test", url: upstream.url }, config.lockDirectory, { waitMs: 0 }),
      ).toMatchObject({
        ok: false,
        error: { kind: "busy" },
      });
      expect(memory.record?.authorization.status).toBe("required");
    } finally {
      release.resolve();
      await pending;
    }

    expect(await pending).toMatchObject({ ok: true });
    expect(memory.record?.authorization.status).toBe("authorized");
  });

  test("logout during browser consent completes immediately and prevents the old login from restoring credentials", async () => {
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

  test("browser presentation failure closes the callback listener and releases ownership", async () => {
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

  test("a later login reuses its saved registration and callback port", async () => {
    await using upstream = await oauthFixture();
    await using config = await configuration(upstream.url);

    const memory = memoryCredentials();

    const options = {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
      authorize: async (url: URL) => {
        await fetch(await upstream.authorize(url));
      },
    };

    expect(await login(config.path, options)).toMatchObject({ ok: true });
    const redirectUri = memory.record?.redirectUri;

    expect(await login(config.path, options)).toMatchObject({ ok: true });
    expect(upstream.registrations).toBe(1);
    expect(upstream.exchanges).toBe(2);
    expect(memory.record?.redirectUri).toBe(redirectUri);
  });

  test("validates PKCE, persists authorization, reuses it after restart, and logs out", async () => {
    await using upstream = await oauthFixture();
    await using config = await configuration(upstream.url);

    const memory = memoryCredentials();
    const options = { store: () => memory.store, lockDirectory: config.lockDirectory };

    const result = await login(config.path, {
      ...options,
      authorize: async (url) => {
        const callback = await upstream.authorize(url);
        expect((await fetch(callback)).status).toBe(200);
        expect((await fetch(callback)).status).toBe(409);
      },
    });

    expect(result).toEqual({ ok: true, value: undefined });
    expect(upstream.exchanges).toBe(1);
    expect(memory.record?.authorization).toMatchObject({
      status: "authorized",
      tokens: { access_token: "access-1" },
    });

    const opened = await OAuthSession.open(
      { id: "test", url: upstream.url },
      memory.store,
      new AbortController().signal,
      config.lockDirectory,
    );

    if (!opened.ok) throw new Error(opened.error.message);

    await using session = opened.value;

    expect(await session.token()).toEqual({ ok: true, value: "access-1" });
    expect(upstream.refreshes).toBe(0);
    expect(await logout(config.path, options)).toEqual({ ok: true, value: undefined });
    expect(memory.record).toBeUndefined();
  });

  test("rejects wrong or duplicate state before accepting a legitimate callback", async () => {
    await using upstream = await oauthFixture();
    await using config = await configuration(upstream.url);

    const memory = memoryCredentials();

    const result = await login(config.path, {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
      authorize: async (url) => {
        const callback = await upstream.authorize(url);
        const wrong = new URL(callback);
        wrong.searchParams.set("state", "incorrect");
        expect((await fetch(wrong)).status).toBe(400);
        const duplicate = new URL(callback);
        duplicate.searchParams.append("state", callback.searchParams.get("state") ?? "");
        expect((await fetch(duplicate)).status).toBe(400);
        expect(upstream.exchanges).toBe(0);
        expect((await fetch(callback)).status).toBe(200);
      },
    });

    expect(result.ok).toBe(true);
    expect(upstream.exchanges).toBe(1);
  });

  test("rejects a mismatched callback issuer before token exchange", async () => {
    await using upstream = await oauthFixture();
    await using config = await configuration(upstream.url);

    const memory = memoryCredentials();

    const result = await login(config.path, {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
      authorize: async (url) => {
        const callback = await upstream.authorize(url);
        callback.searchParams.set("iss", "https://wrong.example/");
        await fetch(callback);
      },
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "invalid" } });
    expect(upstream.exchanges).toBe(0);
  });

  test("denied consent preserves registration without exchanging tokens", async () => {
    await using upstream = await oauthFixture({ deny: true });
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
  });

  test("cancelled login closes the callback listener and releases connection ownership", async () => {
    await using upstream = await oauthFixture();
    await using config = await configuration(upstream.url);

    const memory = memoryCredentials();
    const abort = new AbortController();
    let callback: URL | undefined;

    const result = await login(config.path, {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
      signal: abort.signal,
      authorize: async (url) => {
        callback = await upstream.authorize(url);
        abort.abort();
      },
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "cancelled" } });
    if (callback === undefined) throw new Error("No callback captured");

    expect((await rejectionOf(fetch(callback))).reason).toBeInstanceOf(TypeError);
    expect(
      await logout(config.path, { store: () => memory.store, lockDirectory: config.lockDirectory }),
    ).toMatchObject({ ok: true });
  });
});
