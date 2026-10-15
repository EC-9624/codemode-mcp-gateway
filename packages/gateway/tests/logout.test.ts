import { describe, expect, spyOn, test } from "bun:test";
import { secrets } from "bun";
import { login, logout } from "codemode-mcp-gateway";
import { configuration } from "./support/configuration.ts";
import { memoryCredentials, oauthFixture } from "./support/oauth.ts";

describe("logout", () => {
  test("removes only the selected id and URL from the OS credential service", async () => {
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

    const entries = new Map<string, string>();

    using read = spyOn(secrets, "get").mockImplementation(
      async (key) => entries.get(key.service + ":" + key.name) ?? null,
    );

    using write = spyOn(secrets, "set").mockImplementation(async (key) => {
      entries.set(key.service + ":" + key.name, key.value);
    });

    using remove = spyOn(secrets, "delete").mockImplementation(async (key) =>
      entries.delete(key.service + ":" + key.name),
    );

    for (const [config, upstream] of [
      [personal, notes],
      [work, notes],
      [other, calendar],
    ] as const) {
      expect(
        await login(config.path, {
          lockDirectory: personal.lockDirectory,
          authorize: async (url) => {
            await fetch(await upstream.authorize(url));
          },
        }),
      ).toMatchObject({ ok: true });
    }

    const saved = new Map(entries);
    expect(saved.size).toBe(3);
    const selected = write.mock.calls[0]?.[0];
    if (selected === undefined) throw new Error("Expected saved personal credentials");

    const result = await logout(personal.path, { lockDirectory: personal.lockDirectory });

    expect(result).toEqual({ ok: true, value: undefined });
    expect(remove).toHaveBeenCalledWith({ service: selected.service, name: selected.name });
    saved.delete(selected.service + ":" + selected.name);
    expect(entries).toEqual(saved);
    expect(entries.size).toBe(2);
    expect(read).toHaveBeenCalled();
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

  test("returns a controlled storage failure when the OS service cannot delete credentials", async () => {
    await using config = await configuration({
      type: "remote",
      url: "https://example.com/mcp",
      oauth: {},
    });

    using read = spyOn(secrets, "get").mockResolvedValue(null);
    using write = spyOn(secrets, "set").mockResolvedValue(undefined);
    using remove = spyOn(secrets, "delete").mockRejectedValue(new Error("private keychain detail"));

    const result = await logout(config.path, { lockDirectory: config.lockDirectory });

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "storage",
        message: "Could not remove OAuth credentials from the OS credential store.",
      },
    });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
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
