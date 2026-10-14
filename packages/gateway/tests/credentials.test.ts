import { describe, expect, test } from "bun:test";
import { Credentials } from "codemode-mcp-gateway";

describe("Credentials", () => {
  test("accepts a registered connection awaiting authorization", () => {
    const input = {
      version: 1,
      upstreamUrl: "https://example.com/mcp",
      issuer: "https://auth.example.com/",
      resource: null,
      redirectUri: "http://127.0.0.1:49152/oauth/callback",
      client: { client_id: "registered-client" },
      authorization: { status: "required" },
    } satisfies Credentials;

    const result = Credentials.safeParse(input);

    expect(result.success).toBe(true);
    if (!result.success) throw result.error;

    expect(result.data).toEqual(input);
  });

  test.each(["Bearer", "bearer"])("accepts an authorized snapshot with %s tokens", (tokenType) => {
    const input = {
      version: 1,
      upstreamUrl: "https://example.com/mcp",
      issuer: "https://auth.example.com/",
      resource: "https://example.com/mcp",
      redirectUri: "http://127.0.0.1:49152/oauth/callback",
      client: { client_id: "registered-client" },
      authorization: {
        status: "authorized",
        receivedAt: 1_700_000_000_000,
        tokens: {
          access_token: "synthetic-access",
          token_type: tokenType,
          refresh_token: "synthetic-refresh",
          expires_in: 3600,
        },
      },
    } satisfies Credentials;

    const result = Credentials.safeParse(input);

    expect(result.success).toBe(true);
    if (!result.success) throw result.error;

    expect(result.data).toEqual(input);
  });

  test.each([
    { name: "an unsupported version", change: { version: 2 } },
    { name: "a malformed upstream URL", change: { upstreamUrl: "not a URL" } },
    { name: "an empty client id", change: { client: { client_id: "" } } },
    { name: "an unknown authorization status", change: { authorization: { status: "pending" } } },
    {
      name: "missing authorized tokens",
      change: { authorization: { status: "authorized", receivedAt: 0 } },
    },
    {
      name: "tokens on an unauthorized registration",
      change: { authorization: { status: "required", tokens: {} } },
    },
  ])("rejects $name", ({ change }) => {
    const input = {
      version: 1,
      upstreamUrl: "https://example.com/mcp",
      issuer: "https://auth.example.com/",
      resource: null,
      redirectUri: "http://127.0.0.1:49152/oauth/callback",
      client: { client_id: "registered-client" },
      authorization: { status: "required" },
      ...change,
    };

    const result = Credentials.safeParse(input);

    expect(result.success).toBe(false);
  });

  test.each([
    {
      name: "a negative timestamp",
      authorization: {
        receivedAt: -1,
        tokens: { access_token: "synthetic", token_type: "Bearer" },
      },
    },
    {
      name: "a fractional timestamp",
      authorization: {
        receivedAt: 1.5,
        tokens: { access_token: "synthetic", token_type: "Bearer" },
      },
    },
    {
      name: "an empty access token",
      authorization: { receivedAt: 0, tokens: { access_token: "", token_type: "Bearer" } },
    },
    {
      name: "an unsupported token type",
      authorization: { receivedAt: 0, tokens: { access_token: "synthetic", token_type: "Basic" } },
    },
    {
      name: "a negative token lifetime",
      authorization: {
        receivedAt: 0,
        tokens: { access_token: "synthetic", token_type: "Bearer", expires_in: -1 },
      },
    },
  ])("rejects an authorized snapshot with $name", ({ authorization }) => {
    const input = {
      version: 1,
      upstreamUrl: "https://example.com/mcp",
      issuer: "https://auth.example.com/",
      resource: null,
      redirectUri: "http://127.0.0.1:49152/oauth/callback",
      client: { client_id: "registered-client" },
      authorization: { status: "authorized", ...authorization },
    };

    const result = Credentials.safeParse(input);

    expect(result.success).toBe(false);
  });
});
