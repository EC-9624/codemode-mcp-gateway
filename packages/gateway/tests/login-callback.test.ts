import { describe, expect, test } from "bun:test";
import { login } from "codemode-mcp-gateway";
import { configuration } from "./support/configuration.ts";
import { memoryCredentials, oauthFixture } from "./support/oauth.ts";

describe("login callback", () => {
  test.each([
    { name: "an unrelated method", method: "POST", path: undefined, headers: undefined },
    { name: "an unrelated path", method: "GET", path: "/other", headers: undefined },
    { name: "an unrelated host", method: "GET", path: undefined, headers: { Host: "example.com" } },
  ])("ignores $name without consuming the valid callback", async ({ method, path, headers }) => {
    await using upstream = await oauthFixture();

    await using config = await configuration({
      transport: "http",
      id: "notes",
      url: upstream.url,
      auth: { type: "oauth" },
    });

    const memory = memoryCredentials();
    const responses: Response[] = [];
    const exchanges: number[] = [];

    const result = await login(config.path, {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
      authorize: async (url) => {
        const callback = await upstream.authorize(url);
        responses.push(
          await fetch(path === undefined ? callback : new URL(path, callback), {
            method,
            ...(headers === undefined ? {} : { headers }),
          }),
        );
        exchanges.push(upstream.exchanges);
        responses.push(await fetch(callback));
      },
    });

    expect(responses.map((response) => response.status)).toEqual([404, 200]);
    expect(responses[0]?.headers.get("cache-control")).toBe("no-store");
    expect(responses[0]?.headers.get("referrer-policy")).toBe("no-referrer");
    expect(exchanges).toEqual([0]);
    expect(result).toEqual({ ok: true, value: undefined });
    expect(upstream.exchanges).toBe(1);
  });

  test.each([
    { name: "incorrect state", states: ["not-the-issued-state"] },
    { name: "duplicate state", states: ["first-state", "second-state"] },
  ])("rejects $name without consuming the valid callback", async ({ states }) => {
    await using upstream = await oauthFixture();

    await using config = await configuration({
      transport: "http",
      id: "notes",
      url: upstream.url,
      auth: { type: "oauth" },
    });

    const memory = memoryCredentials();
    const statuses: number[] = [];
    const exchanges: number[] = [];

    const result = await login(config.path, {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
      authorize: async (url) => {
        const callback = await upstream.authorize(url);
        const invalid = new URL(callback);
        invalid.searchParams.delete("state");
        for (const state of states) invalid.searchParams.append("state", state);

        statuses.push((await fetch(invalid)).status);
        exchanges.push(upstream.exchanges);
        statuses.push((await fetch(callback)).status);
      },
    });

    expect(statuses).toEqual([400, 200]);
    expect(exchanges).toEqual([0]);
    expect(result).toEqual({ ok: true, value: undefined });
    expect(upstream.exchanges).toBe(1);
  });

  test("rejects a replay after accepting the matching callback once", async () => {
    await using upstream = await oauthFixture();

    await using config = await configuration({
      transport: "http",
      id: "notes",
      url: upstream.url,
      auth: { type: "oauth" },
    });

    const memory = memoryCredentials();
    const statuses: number[] = [];

    const result = await login(config.path, {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
      authorize: async (url) => {
        const callback = await upstream.authorize(url);
        statuses.push((await fetch(callback)).status);
        statuses.push((await fetch(callback)).status);
      },
    });

    expect(statuses).toEqual([200, 409]);
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

    await using config = await configuration({
      transport: "http",
      id: "notes",
      url: upstream.url,
      auth: { type: "oauth" },
    });

    const memory = memoryCredentials();
    const statuses: number[] = [];

    const result = await login(config.path, {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
      authorize: async (url) => {
        const callback = await upstream.authorize(url);
        const fields = new URLSearchParams(parameters);
        callback.searchParams.delete("code");
        for (const name of new Set(fields.keys())) callback.searchParams.delete(name);

        for (const [name, value] of fields) callback.searchParams.append(name, value);

        statuses.push((await fetch(callback)).status);
      },
    });

    expect(statuses).toEqual([200]);
    expect(result).toMatchObject({ ok: false, error: { kind: "invalid" } });
    expect(upstream.exchanges).toBe(0);
    expect(memory.record?.authorization).toEqual({ status: "required" });
  });
});
