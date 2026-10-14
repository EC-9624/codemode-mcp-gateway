import { describe, expect, test } from "bun:test";
import { credentialStore, credentialName, type Credentials } from "../../src/auth/credentials.ts";

const connection = { id: "notion", url: "https://example.com/mcp" };

const record = {
  version: 1,
  upstreamUrl: connection.url,
  issuer: "https://auth.example/",
  resource: connection.url,
  redirectUri: "http://127.0.0.1:49152/oauth/callback",
  client: { client_id: "test" },
  authorization: {
    status: "authorized",
    receivedAt: 1,
    tokens: {
      access_token: "synthetic-access",
      refresh_token: "synthetic-refresh",
      token_type: "Bearer",
    },
  },
} satisfies Credentials;

function secretService(initial: string | null = null) {
  let stored = initial;

  return {
    async get() {
      return stored;
    },
    async set(key: { value: string }) {
      stored = key.value;
    },
    async delete() {
      const existed = stored !== null;
      stored = null;

      return existed;
    },
    get stored() {
      return stored;
    },
  };
}

describe("scoped OS credential adapter", () => {
  test("round trips a complete credential snapshot and clears it", async () => {
    const service = secretService();
    const store = credentialStore(connection, service);

    expect(await store.load()).toEqual({ ok: true, value: undefined });
    expect(await store.save(record)).toMatchObject({ ok: true });
    expect(await store.load()).toEqual({ ok: true, value: record });
    expect(await store.clear()).toMatchObject({ ok: true });
    expect(service.stored).toBeNull();
  });

  test.each([
    ["invalid JSON", "private-malformed-value"],
    ["unknown version", JSON.stringify({ ...record, version: 2 })],
    ["different upstream", JSON.stringify({ ...record, upstreamUrl: "https://other.example/mcp" })],
  ])("rejects %s without exposing stored values", async (_name, value) => {
    const result = await credentialStore(connection, secretService(value)).load();

    expect(result).toMatchObject({ ok: false, error: { kind: "invalid" } });
    if (!result.ok) expect(result.error.message).not.toContain(value);
  });

  test("storage failure has no plaintext fallback and hides the dependency message", async () => {
    const service = {
      ...secretService(),
      set: async () => {
        throw new Error("private storage detail");
      },
    };

    const result = await credentialStore(connection, service).save(record);

    expect(result).toMatchObject({ ok: false, error: { kind: "storage" } });
    if (!result.ok) expect(result.error.message).not.toContain("private storage detail");
  });

  test("credential identity changes with the connection id or upstream URL", () => {
    expect(credentialName(connection)).not.toBe(credentialName({ ...connection, id: "other" }));
    expect(credentialName(connection)).not.toBe(
      credentialName({ ...connection, url: "https://other.example/mcp" }),
    );
  });
});
