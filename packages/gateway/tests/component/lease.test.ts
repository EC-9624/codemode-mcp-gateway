import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLease } from "../../src/auth/lease.ts";
import { credentialName, type CredentialStore } from "../../src/auth/credentials.ts";
import { AuthResult } from "../../src/auth/result.ts";

const connection = { id: "test", url: "https://example.com/mcp" };

describe("OAuth credential-operation ownership", () => {
  test("excludes another owner and releases the actual lock on disposal", async () => {
    await using cleanup = new AsyncDisposableStack();

    const directory = await mkdtemp(join(tmpdir(), "cmg-lease-"));
    cleanup.defer(() => rm(directory, { recursive: true, force: true }));
    const first = await acquireLease(connection, directory);
    if (!first.ok) throw new Error(first.error.message);

    cleanup.use(first.value);
    expect(await acquireLease(connection, directory, { waitMs: 0 })).toMatchObject({
      ok: false,
      error: { kind: "busy" },
    });
    await first.value[Symbol.asyncDispose]();
    const recovered = await acquireLease(connection, directory);
    if (!recovered.ok) throw new Error(recovered.error.message);

    cleanup.use(recovered.value);
    expect(recovered.ok).toBe(true);
  });

  test("recovers a killed process's stale lock", async () => {
    await using cleanup = new AsyncDisposableStack();

    const directory = await mkdtemp(join(tmpdir(), "cmg-lease-crash-"));
    cleanup.defer(() => rm(directory, { recursive: true, force: true }));

    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../fixtures/oauth-lease.ts", import.meta.url)),
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
    const output = await reader.read();
    expect(new TextDecoder().decode(output.value)).toContain("owned");
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
    // Age the abandoned heartbeat to exercise recovery without a twenty-second test sleep.
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

  test("cancellation stops waiting for a held credential lock", async () => {
    await using cleanup = new AsyncDisposableStack();

    const directory = await mkdtemp(join(tmpdir(), "cmg-lease-cancel-"));
    cleanup.defer(() => rm(directory, { recursive: true, force: true }));
    const first = await acquireLease(connection, directory);
    if (!first.ok) throw new Error(first.error.message);

    cleanup.use(first.value);
    const abort = new AbortController();
    const waiting = acquireLease(connection, directory, { signal: abort.signal });
    abort.abort();

    expect(await waiting).toMatchObject({ ok: false, error: { kind: "cancelled" } });
    expect(first.value.check()).toMatchObject({ ok: true });
  });

  test("lost ownership aborts the operation and prevents further credential writes", async () => {
    await using cleanup = new AsyncDisposableStack();

    const directory = await mkdtemp(join(tmpdir(), "cmg-lease-lost-"));
    cleanup.defer(() => rm(directory, { recursive: true, force: true }));
    const acquired = await acquireLease(connection, directory);
    if (!acquired.ok) throw new Error(acquired.error.message);

    const lease = cleanup.use(acquired.value);
    const lost = Promise.withResolvers<void>();
    lease.signal.addEventListener("abort", () => lost.resolve(), { once: true });
    let cleared = false;

    const store = {
      load: async () => AuthResult.success(undefined),
      save: async () => AuthResult.success(undefined),
      clear: async () => {
        cleared = true;

        return AuthResult.success(undefined);
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
