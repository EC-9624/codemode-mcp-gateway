import { describe, expect, spyOn, test } from "bun:test";
import { promises } from "node:fs";
import { readdir } from "node:fs/promises";
import { login, logout } from "codemode-mcp-gateway";
import { configuration } from "./support/configuration.ts";
import { memoryCredentials, oauthFixture } from "./support/oauth.ts";
import { credentialFiles } from "./support/credentials.ts";

describe("logout", () => {
  test("removes only the selected id and URL from file-backed credentials", async () => {
    await using notes = await oauthFixture();
    await using calendar = await oauthFixture();

    await using personal = await configuration(
      {
        type: "remote",
        url: notes.url,
        oauth: {},
      },
      "personal",
    );

    await using work = await configuration(
      {
        type: "remote",
        url: notes.url,
        oauth: {},
      },
      "work",
    );

    await using other = await configuration(
      {
        type: "remote",
        url: calendar.url,
        oauth: {},
      },
      "personal",
    );

    await using files = await credentialFiles();

    for (const [config, upstream] of [
      [personal, notes],
      [work, notes],
      [other, calendar],
    ] as const) {
      expect(
        await login(config.path, {
          store: files.store,
          lockDirectory: personal.lockDirectory,
          authorize: async (url) => {
            await fetch(await upstream.authorize(url));
          },
        }),
      ).toMatchObject({ ok: true });
    }

    const selected = files.store({ id: "personal", url: notes.url });
    const unselected = files.store({ id: "work", url: notes.url });
    const differentUrl = files.store({ id: "personal", url: calendar.url });
    const savedWork = await unselected.load();
    const savedOther = await differentUrl.load();
    expect((await readdir(files.directory)).length).toBe(3);

    const result = await logout(personal.path, {
      store: files.store,
      lockDirectory: personal.lockDirectory,
    });

    expect(result).toEqual({ ok: true, value: undefined });
    expect(await selected.load()).toEqual({ ok: true, value: undefined });
    expect(await unselected.load()).toEqual(savedWork);
    expect(await differentUrl.load()).toEqual(savedOther);
    expect((await readdir(files.directory)).length).toBe(2);
  });

  test("succeeds when local credentials are already absent without contacting the provider", async () => {
    await using upstream = await oauthFixture();

    await using config = await configuration({
      type: "remote",
      url: upstream.url,
      oauth: {},
    });

    const memory = memoryCredentials();

    const result = await logout(config.path, {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
    });

    expect(result).toEqual({ ok: true, value: undefined });
    expect(memory.record).toBeUndefined();
    expect(upstream.requests).toEqual([]);
  });

  test("removes registration and tokens without revoking the grant upstream", async () => {
    await using upstream = await oauthFixture();

    await using config = await configuration({
      type: "remote",
      url: upstream.url,
      oauth: {},
    });

    const memory = memoryCredentials(upstream.credentials());

    const result = await logout(config.path, {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
    });

    expect(result).toEqual({ ok: true, value: undefined });
    expect(memory.record).toBeUndefined();
    expect(upstream.requests).toEqual([]);
  });

  test("returns a controlled storage failure when the credential file cannot be deleted", async () => {
    await using config = await configuration({
      type: "remote",
      url: "https://example.com/mcp",
      oauth: {},
    });

    await using upstream = await oauthFixture();
    await using files = await credentialFiles();
    const store = files.store({ id: "notes", url: "https://example.com/mcp" });
    expect(
      await store.save({ ...upstream.credentials(), upstreamUrl: "https://example.com/mcp" }),
    ).toMatchObject({ ok: true });

    using remove = spyOn(promises, "unlink").mockRejectedValue(
      new Error("private filesystem detail"),
    );

    const result = await logout(config.path, {
      store: files.store,
      lockDirectory: config.lockDirectory,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "storage",
        message: "Could not remove the OAuth credential file.",
      },
    });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(await store.load()).toMatchObject({
      ok: true,
      value: { upstreamUrl: "https://example.com/mcp" },
    });
  });

  test("logout during consent prevents a pending login from restoring credentials", async () => {
    await using upstream = await oauthFixture();

    await using config = await configuration({
      type: "remote",
      url: upstream.url,
      oauth: {},
    });

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
});
