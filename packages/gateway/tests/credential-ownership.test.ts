import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";
import { type CredentialStore } from "codemode-mcp-gateway";
import { memoryCredentials, oauthFixture } from "./support/oauth.ts";
import { acquireLease } from "../src/auth/lease.ts";
import { credentialName } from "../src/auth/credentials.ts";
import { OAuthSession } from "../src/auth/session.ts";

// Public serving tests own auth behavior. These probes need control over individual
// store completions and abandoned/compromised lock owners that serve does not expose.
describe("credential ownership fault boundaries", () => {
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
      { id: "notes", url: upstream.url },
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
      release.resolve();
      expect(await delayed).toMatchObject({ ok: false, error: { kind: "unavailable" } });
      expect(await session.token()).toMatchObject({ ok: false, error: { kind: "unavailable" } });
      expect(upstream.refreshes).toBe(1);
    } finally {
      release.resolve();
      await delayed;
    }
  });

  test("refresh consumers cannot observe rotation before durable persistence", async () => {
    await using upstream = await oauthFixture();
    const memory = memoryCredentials(upstream.credentials(Date.now() - 4_000_000));
    const saving = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const store = {
      ...memory.store,
      async save(value) {
        saving.resolve();
        await release.promise;

        return memory.store.save(value);
      },
    } satisfies CredentialStore;

    const opened = await OAuthSession.open(
      { id: "notes", url: upstream.url },
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
      await saving.promise;
      await setImmediate();
      expect(published).toBe(0);
      expect(memory.writes).toBe(0);
      expect(memory.record?.authorization).toMatchObject({ tokens: { access_token: "access-0" } });
    } finally {
      release.resolve();
    }

    expect(await first).toEqual({ ok: true, value: "access-1" });
    expect(await second).toEqual({ ok: true, value: "access-1" });
    expect(upstream.refreshes).toBe(1);
    expect(memory.record?.authorization).toMatchObject({ tokens: { refresh_token: "refresh-1" } });
  });

  test("a killed owner's lock excludes competitors until its heartbeat becomes stale", async () => {
    await using cleanup = new AsyncDisposableStack();
    const connection = { id: "test", url: "https://example.com/mcp" };
    const directory = await mkdtemp(join(tmpdir(), "cmg-lease-crash-"));
    cleanup.defer(() => rm(directory, { recursive: true, force: true }));

    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("./fixtures/oauth-lease.ts", import.meta.url)),
        directory,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const watchdog = setTimeout(() => child.kill("SIGKILL"), 4_000);
    cleanup.defer(() => clearTimeout(watchdog));
    cleanup.defer(async () => {
      child.kill("SIGKILL");
      await child.exited;
    });
    const reader = child.stdout.getReader();
    cleanup.defer(() => reader.releaseLock());

    expect(new TextDecoder().decode((await reader.read()).value)).toContain("owned");
    expect(await acquireLease(connection, directory, { waitMs: 0 })).toMatchObject({
      ok: false,
      error: { kind: "busy" },
    });
    child.kill("SIGKILL");
    await child.exited;
    expect(await acquireLease(connection, directory, { waitMs: 0 })).toMatchObject({
      ok: false,
      error: { kind: "busy" },
    });
    // Exercise real stale-lock recovery without sleeping for the twenty-second lease.
    const expired = new Date(Date.now() - 30_000);
    await utimes(
      join(directory, credentialName(connection) + ".credentials.lock"),
      expired,
      expired,
    );
    const recovered = await acquireLease(connection, directory);
    if (!recovered.ok) throw new Error(recovered.error.message);

    cleanup.use(recovered.value);
    expect(recovered.ok).toBe(true);
  });

  test("a compromised owner cannot write credentials or remove its successor's lock", async () => {
    await using cleanup = new AsyncDisposableStack();
    const connection = { id: "notes", url: "https://example.com/mcp" };
    const directory = await mkdtemp(join(tmpdir(), "cmg-lease-lost-"));
    cleanup.defer(() => rm(directory, { recursive: true, force: true }));
    const acquired = await acquireLease(connection, directory);
    if (!acquired.ok) throw new Error(acquired.error.message);

    const lease = cleanup.use(acquired.value);
    const lost = Promise.withResolvers<void>();
    lease.signal.addEventListener("abort", () => lost.resolve(), { once: true });
    let cleared = false;

    const store = {
      ...memoryCredentials().store,
      clear: async () => {
        cleared = true;

        return { ok: true, value: undefined };
      },
    } satisfies CredentialStore;

    await rm(join(directory, credentialName(connection) + ".credentials.lock"), {
      recursive: true,
    });
    await lost.promise;
    expect(await lease.guard(store).clear()).toMatchObject({ ok: false, error: { kind: "busy" } });
    expect(cleared).toBe(false);
    const successor = await acquireLease(connection, directory);
    if (!successor.ok) throw new Error(successor.error.message);

    cleanup.use(successor.value);
    await lease[Symbol.asyncDispose]();
    expect(await acquireLease(connection, directory, { waitMs: 0 })).toMatchObject({
      ok: false,
      error: { kind: "busy" },
    });
  });
});
