import { describe, expect, spyOn, test } from "bun:test";
import { promises } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileCredentialStore, type Credentials } from "codemode-mcp-gateway";
import { credentialFiles } from "./support/credentials.ts";
import { within } from "./support/gateway.ts";

const connection = { id: "notes", url: "https://example.com/" };

const record = {
  version: 1,
  upstreamUrl: "https://example.com/",
  issuer: "https://auth.example.com/",
  resource: "https://example.com/",
  redirectUri: "http://127.0.0.1:49152/oauth/callback",
  client: { client_id: "synthetic-client" },
  authorization: {
    status: "authorized",
    receivedAt: 1_700_000_000_000,
    tokens: {
      access_token: "synthetic-access",
      refresh_token: "synthetic-refresh",
      token_type: "Bearer",
    },
  },
} satisfies Credentials;

// Real filesystem boundary tests: modes, symlinks, and atomic replacement cannot be established by an in-memory mock.
describe("fileCredentialStore", () => {
  test("loading and clearing missing credentials do not create the directory", async () => {
    await using files = await credentialFiles();
    const store = files.store(connection);

    expect(await store.load()).toEqual({ ok: true, value: undefined });
    expect(await store.clear()).toEqual({ ok: true, value: undefined });
    expect(await readdir(files.root)).toEqual([]);
  });

  test("persists a private versioned snapshot that a newly constructed store can read", async () => {
    await using files = await credentialFiles();
    const store = files.store(connection);

    expect(await store.save(record)).toEqual({ ok: true, value: undefined });

    expect(await files.store(connection).load()).toEqual({ ok: true, value: record });
    expect(JSON.parse(await readFile(await files.path(), "utf8"))).toEqual(record);
    expect((await readdir(files.directory))[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    expect((await lstat(files.directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(await files.path())).mode & 0o777).toBe(0o600);
  });

  test("server name and canonical URL select the snapshot without using the name as a path", async () => {
    await using files = await credentialFiles();
    const store = files.store({ id: "../../notes", url: "https://example.com" });
    expect(await store.save(record)).toMatchObject({ ok: true });

    expect(await files.store({ id: "../../notes", url: "https://example.com/" }).load()).toEqual({
      ok: true,
      value: record,
    });
    expect(await files.store(connection).load()).toEqual({ ok: true, value: undefined });
    expect(
      await files.store({ id: "../../notes", url: "https://example.com/other" }).load(),
    ).toEqual({ ok: true, value: undefined });
    expect(await readdir(files.root)).toEqual(["credentials"]);
  });

  test("an existing store observes another store's replacement and removal", async () => {
    await using files = await credentialFiles();
    const reader = files.store(connection);
    const writer = files.store(connection);
    expect(await writer.save(record)).toMatchObject({ ok: true });
    expect(await reader.load()).toEqual({ ok: true, value: record });
    const replacement = { ...record, authorization: { status: "required" } } satisfies Credentials;

    expect(await writer.save(replacement)).toMatchObject({ ok: true });
    expect(await reader.load()).toEqual({ ok: true, value: replacement });
    expect(await writer.clear()).toMatchObject({ ok: true });
    expect(await reader.load()).toEqual({ ok: true, value: undefined });
    expect(await writer.clear()).toMatchObject({ ok: true });
  });

  test("refuses a save bound to another upstream without replacing existing credentials", async () => {
    await using files = await credentialFiles();
    const store = files.store(connection);
    expect(await store.save(record)).toMatchObject({ ok: true });

    expect(await store.save({ ...record, upstreamUrl: "https://other.example/" })).toMatchObject({
      ok: false,
      error: { kind: "invalid" },
    });
    expect(await store.load()).toEqual({ ok: true, value: record });
    expect((await readdir(files.directory)).length).toBe(1);
  });

  test("publishes a replacement only after complete bytes are ready", async () => {
    await using files = await credentialFiles();
    const store = files.store(connection);
    expect(await store.save(record)).toMatchObject({ ok: true });
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const rename = promises.rename.bind(promises);

    using publication = spyOn(promises, "rename").mockImplementation(async (from, to) => {
      ready.resolve();
      await release.promise;
      await rename(from, to);
    });

    const replacement = { ...record, authorization: { status: "required" } } satisfies Credentials;
    const saving = store.save(replacement);

    try {
      await within(ready.promise);
      expect(await store.load()).toEqual({ ok: true, value: record });
    } finally {
      release.resolve();
      await saving;
    }

    expect(await saving).toMatchObject({ ok: true });
    expect(await store.load()).toEqual({ ok: true, value: replacement });
    expect((await readdir(files.directory)).length).toBe(1);
    expect(publication).toHaveBeenCalledTimes(1);
  });

  test("failed publication preserves the prior grant and removes temporary credential bytes", async () => {
    await using files = await credentialFiles();
    const store = files.store(connection);
    expect(await store.save(record)).toMatchObject({ ok: true });

    using publication = spyOn(promises, "rename").mockRejectedValue(
      new Error("private filesystem detail"),
    );

    const result = await store.save({ ...record, authorization: { status: "required" } });

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "storage",
        message: "Could not save the OAuth credential file. Authorization may need to be repeated.",
      },
    });
    expect(await store.load()).toEqual({ ok: true, value: record });
    expect((await readdir(files.directory)).length).toBe(1);
    expect(publication).toHaveBeenCalledTimes(1);
  });

  test("malformed snapshots are invalid, not absent, and can be explicitly cleared", async () => {
    await using files = await credentialFiles();
    const store = files.store(connection);
    expect(await store.save(record)).toMatchObject({ ok: true });
    await writeFile(await files.path(), "private malformed credentials");

    expect(await store.load()).toMatchObject({
      ok: false,
      error: {
        kind: "invalid",
        message: "Stored OAuth credentials are invalid. Run gw logout, then gw login.",
      },
    });
    expect(await store.clear()).toMatchObject({ ok: true });
    expect(await readdir(files.directory)).toEqual([]);
  });

  test.each(["", "relative/credentials"])(
    "rejects the relative directory %j without I/O",
    async (directory) => {
      const store = fileCredentialStore(connection, { directory });

      expect(await store.load()).toMatchObject({ ok: false, error: { kind: "invalid" } });
      expect(await store.save(record)).toMatchObject({ ok: false, error: { kind: "invalid" } });
      expect(await store.clear()).toMatchObject({ ok: false, error: { kind: "invalid" } });
    },
  );

  test("rejects an invalid upstream URL through the result contract", async () => {
    await using files = await credentialFiles();
    const store = files.store({ id: "notes", url: "relative" });

    expect(await store.load()).toMatchObject({ ok: false, error: { kind: "invalid" } });
    expect(await readdir(files.root)).toEqual([]);
  });

  test.each(["", "/"])(
    "refuses a symlinked credential directory with suffix %j without modifying its target",
    async (suffix) => {
      await using files = await credentialFiles();
      const target = join(files.root, "target");
      await mkdir(target, { mode: 0o700 });
      await symlink(target, files.directory);
      const store = fileCredentialStore(connection, { directory: files.directory + suffix });

      expect(await store.load()).toMatchObject({ ok: false, error: { kind: "storage" } });
      expect(await store.save(record)).toMatchObject({ ok: false, error: { kind: "storage" } });
      expect(await store.clear()).toMatchObject({ ok: false, error: { kind: "storage" } });
      expect(await readdir(target)).toEqual([]);
    },
  );

  test("refuses a symlinked credential file without reading, replacing, or deleting its target", async () => {
    await using files = await credentialFiles();
    const store = files.store(connection);
    expect(await store.save(record)).toMatchObject({ ok: true });
    const path = await files.path();
    const target = join(files.root, "target.json");
    await writeFile(target, JSON.stringify(record), { mode: 0o600 });
    expect(await store.clear()).toMatchObject({ ok: true });
    await symlink(target, path);

    expect(await store.load()).toMatchObject({ ok: false, error: { kind: "storage" } });
    expect(await store.save(record)).toMatchObject({ ok: false, error: { kind: "storage" } });
    expect(await store.clear()).toMatchObject({ ok: false, error: { kind: "storage" } });
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(record);
  });

  test.each([
    { name: "directory", mode: 0o755, path: (directory: string, _file: string) => directory },
    { name: "file", mode: 0o644, path: (_directory: string, file: string) => file },
  ])(
    "refuses a nonprivate credential $name without changing its permissions",
    async ({ mode, path }) => {
      await using files = await credentialFiles();
      const store = files.store(connection);
      expect(await store.save(record)).toMatchObject({ ok: true });
      const unsafe = path(files.directory, await files.path());
      await chmod(unsafe, mode);

      expect(await store.load()).toMatchObject({ ok: false, error: { kind: "storage" } });
      expect(await store.save(record)).toMatchObject({ ok: false, error: { kind: "storage" } });
      expect(await store.clear()).toMatchObject({ ok: false, error: { kind: "storage" } });
      expect((await lstat(unsafe)).mode & 0o777).toBe(mode);
    },
  );
});
