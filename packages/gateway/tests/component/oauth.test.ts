import { describe, expect, test } from "bun:test";
import { OAuthSession } from "../../src/auth/session.ts";
import { AuthResult } from "../../src/auth/result.ts";
import { memoryCredentials, oauthFixture } from "../support/oauth.ts";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { credentialName, type CredentialStore } from "../../src/auth/credentials.ts";

describe("OAuth session", () => {
  test("an older credential read cannot erase a newer snapshot's failed refresh", async () => {
    await using upstream = await oauthFixture({
      refresh: async () => Response.json({ error: "server_error" }, { status: 503 }),
    });

    const memory = memoryCredentials(upstream.credentials(Date.now() - 4_000_000));
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let delayNext = false;

    const store = {
      ...memory.store,
      async load() {
        const snapshot = await memory.store.load();
        if (delayNext) {
          delayNext = false;
          started.resolve();
          await release.promise;
        }

        return snapshot;
      },
    } satisfies CredentialStore;

    const opened = await OAuthSession.open(
      { id: "test", url: upstream.url },
      store,
      new AbortController().signal,
      upstream.lockDirectory,
    );

    if (!opened.ok) throw new Error(opened.error.message);

    await using session = opened.value;

    delayNext = true;
    const delayed = session.token();
    try {
      await started.promise;
      const replacement = upstream.credentials(Date.now() - 4_000_001);
      if (replacement.authorization.status !== "authorized")
        throw new Error("Missing synthetic grant");

      replacement.authorization.tokens.access_token = "replacement-access";
      replacement.authorization.tokens.refresh_token = "replacement-refresh";
      await memory.store.save(replacement);

      expect(await session.token()).toMatchObject({ ok: false, error: { kind: "unavailable" } });
      expect(upstream.refreshes).toBe(1);
      release.resolve();

      expect(await delayed).toMatchObject({ ok: false, error: { kind: "unavailable" } });
      expect(await session.token()).toMatchObject({ ok: false, error: { kind: "unavailable" } });
      expect(upstream.refreshes).toBe(1);
    } finally {
      release.resolve();
      await delayed;
    }
  });

  test("losing the refresh lock cancels the request and prevents token persistence", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    await using upstream = await oauthFixture({
      refresh: async () => {
        started.resolve();
        await release.promise;

        return undefined;
      },
    });

    const connection = { id: "test", url: upstream.url };
    const memory = memoryCredentials(upstream.credentials(Date.now() - 4_000_000));

    const opened = await OAuthSession.open(
      connection,
      memory.store,
      new AbortController().signal,
      upstream.lockDirectory,
    );

    if (!opened.ok) throw new Error(opened.error.message);

    await using session = opened.value;

    const pending = session.token();
    try {
      await started.promise;
      await rm(join(upstream.lockDirectory, credentialName(connection) + ".credentials.lock"), {
        recursive: true,
      });
      expect(await pending).toMatchObject({ ok: false, error: { kind: "busy" } });
      expect(memory.writes).toBe(0);
      expect(await session.token()).toMatchObject({ ok: false, error: { kind: "busy" } });
      expect(upstream.refreshes).toBe(1);
    } finally {
      release.resolve();
    }
  });

  test("a running session adopts credentials saved by a later login", async () => {
    await using upstream = await oauthFixture();

    const memory = memoryCredentials(upstream.credentials());

    const opened = await OAuthSession.open(
      { id: "test", url: upstream.url },
      memory.store,
      new AbortController().signal,
      upstream.lockDirectory,
    );

    if (!opened.ok) throw new Error(opened.error.message);

    await using session = opened.value;

    await memory.store.clear();
    expect(await session.token()).toMatchObject({ ok: false, error: { kind: "required" } });
    const replacement = upstream.credentials();
    if (replacement.authorization.status !== "authorized")
      throw new Error("Missing synthetic authorization");

    replacement.authorization.tokens.access_token = "new-login-access";
    await memory.store.save(replacement);

    expect(await session.token()).toEqual({ ok: true, value: "new-login-access" });
    expect(upstream.refreshes).toBe(0);
  });

  test("a late challenge for the previous token does not rotate the current grant again", async () => {
    await using upstream = await oauthFixture();

    const memory = memoryCredentials(upstream.credentials());

    const opened = await OAuthSession.open(
      { id: "test", url: upstream.url },
      memory.store,
      new AbortController().signal,
      upstream.lockDirectory,
    );

    if (!opened.ok) throw new Error(opened.error.message);

    await using session = opened.value;

    const response = new Response("", { status: 401 });
    session.observe(response, { Authorization: "Bearer access-0" });
    expect(await session.token(true)).toEqual({ ok: true, value: "access-1" });
    const provider = session.provider;
    if (provider.onUnauthorized === undefined) throw new Error("Missing challenge handler");

    await provider.onUnauthorized({ response, serverUrl: new URL(upstream.url), fetchFn: fetch });

    expect(upstream.refreshes).toBe(1);
  });

  test("disposal cancels an outstanding refresh without publishing tokens", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    await using upstream = await oauthFixture({
      refresh: async () => {
        started.resolve();
        await release.promise;

        return undefined;
      },
    });

    const memory = memoryCredentials(upstream.credentials(Date.now() - 4_000_000));

    const opened = await OAuthSession.open(
      { id: "test", url: upstream.url },
      memory.store,
      new AbortController().signal,
      upstream.lockDirectory,
    );

    if (!opened.ok) throw new Error(opened.error.message);

    await using session = opened.value;

    const pending = session.token();
    try {
      await started.promise;
      await session[Symbol.asyncDispose]();
      expect(await pending).toMatchObject({ ok: false, error: { kind: "cancelled" } });
      expect(memory.writes).toBe(0);
    } finally {
      release.resolve();
    }
  });

  test("does not contact upstream when login is required", async () => {
    const memory = memoryCredentials();

    const result = await OAuthSession.open(
      { id: "test", url: "http://127.0.0.1:1/mcp" },
      memory.store,
      new AbortController().signal,
    );

    expect(result).toMatchObject({ ok: false, error: { kind: "required" } });
  });

  test("shares one refresh and persists rotation before exposing tokens", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await using upstream = await oauthFixture();

    const memory = memoryCredentials(upstream.credentials(Date.now() - 4_000_000));

    const store = {
      ...memory.store,
      async save(value) {
        started.resolve();
        await release.promise;

        return memory.store.save(value);
      },
    } satisfies CredentialStore;

    const opened = await OAuthSession.open(
      { id: "test", url: upstream.url },
      store,
      new AbortController().signal,
      upstream.lockDirectory,
    );

    if (!opened.ok) throw new Error(opened.error.message);

    await using session = opened.value;

    let published = 0;

    const first = session.token().then((result) => {
      published++;

      return result;
    });

    const second = session.token().then((result) => {
      published++;

      return result;
    });

    try {
      await started.promise;
      // Let runnable consumers settle while persistence remains blocked.
      await setImmediate();
      expect(published).toBe(0);
      expect(memory.writes).toBe(0);
    } finally {
      release.resolve();
    }

    expect(await first).toEqual({ ok: true, value: "access-1" });
    expect(await second).toEqual({ ok: true, value: "access-1" });
    expect(upstream.refreshes).toBe(1);
    expect(memory.record?.authorization).toMatchObject({
      status: "authorized",
      tokens: { refresh_token: "refresh-1" },
    });
  });

  test.each(["rotation", "grant invalidation"])(
    "does not retry when persisting %s fails",
    async (scenario) => {
      await using upstream = await oauthFixture({
        refresh: async () =>
          scenario === "rotation"
            ? undefined
            : Response.json({ error: "invalid_grant" }, { status: 400 }),
      });

      const memory = memoryCredentials(upstream.credentials(Date.now() - 4_000_000));

      const store = {
        ...memory.store,
        save: async () => AuthResult.failure("storage", "Synthetic store failure"),
      };

      const opened = await OAuthSession.open(
        { id: "test", url: upstream.url },
        store,
        new AbortController().signal,
        upstream.lockDirectory,
      );

      if (!opened.ok) throw new Error(opened.error.message);

      await using session = opened.value;

      expect(await session.token()).toMatchObject({ ok: false, error: { kind: "storage" } });
      expect(await session.token()).toMatchObject({ ok: false, error: { kind: "storage" } });
      expect(upstream.refreshes).toBe(1);
    },
  );

  test("preserves registration but invalidates a revoked grant without retrying", async () => {
    await using upstream = await oauthFixture({
      refresh: async () =>
        Response.json(
          { error: "invalid_grant", error_description: "private grant detail" },
          { status: 400 },
        ),
    });

    const memory = memoryCredentials(upstream.credentials(Date.now() - 4_000_000));

    const opened = await OAuthSession.open(
      { id: "test", url: upstream.url },
      memory.store,
      new AbortController().signal,
      upstream.lockDirectory,
    );

    if (!opened.ok) throw new Error(opened.error.message);

    await using session = opened.value;

    const result = await session.token();
    expect(result).toMatchObject({ ok: false, error: { kind: "required" } });
    if (!result.ok) expect(result.error.message).not.toContain("private grant detail");

    expect(await session.token()).toMatchObject({ ok: false, error: { kind: "required" } });
    expect(upstream.refreshes).toBe(1);
    expect(memory.record?.authorization).toEqual({ status: "required" });
    expect(memory.record?.client.client_id).toBe("cmg-test-client");
  });

  test("does not send a refresh token when the discovered issuer changed", async () => {
    await using upstream = await oauthFixture();

    const memory = memoryCredentials({
      ...upstream.credentials(),
      issuer: "https://different.example/",
    });

    const opened = await OAuthSession.open(
      { id: "test", url: upstream.url },
      memory.store,
      new AbortController().signal,
      upstream.lockDirectory,
    );

    expect(opened).toMatchObject({ ok: false, error: { kind: "required" } });
    expect(upstream.refreshes).toBe(0);
  });
});
