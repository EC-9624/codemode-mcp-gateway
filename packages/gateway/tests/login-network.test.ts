import { describe, expect, spyOn, test } from "bun:test";
import { dns } from "bun";
import { z } from "zod";
import { login } from "codemode-mcp-gateway";
import { configuration } from "./support/configuration.ts";
import { memoryCredentials } from "./support/oauth.ts";
import { fetchImplementation } from "./support/network.ts";

const upstream = "https://mcp.example/mcp";
const issuer = "https://auth.example";

describe("login network policy", () => {
  test.each([
    { name: "private IPv4", addresses: [{ address: "10.0.0.1", family: 4, ttl: 0 }] },
    { name: "private IPv6", addresses: [{ address: "fd00::1", family: 6, ttl: 0 }] },
    {
      name: "IPv4-mapped loopback",
      addresses: [{ address: "::ffff:127.0.0.1", family: 6, ttl: 0 }],
    },
    {
      name: "mixed public and private answers",
      addresses: [
        { address: "8.8.8.8", family: 4, ttl: 0 },
        { address: "192.168.1.1", family: 4, ttl: 0 },
      ],
    },
  ])("rejects a hostname resolving to $name before sending HTTP", async ({ addresses }) => {
    await using config = await configuration({ type: "remote", url: upstream, oauth: {} });
    const memory = memoryCredentials();
    using lookup = spyOn(dns, "lookup").mockResolvedValue([...addresses]);

    using network = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Unexpected HTTP request"),
    );

    const result = await login(config.path, {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "invalid" } });
    expect(network).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(memory.writes).toBe(0);
  });

  test.each([
    { name: "loopback HTTP", metadata: "http://127.0.0.1:49152/private" },
    { name: "loopback HTTPS", metadata: "https://127.0.0.1/private" },
    { name: "private IPv4", metadata: "https://10.0.0.1/private" },
    { name: "link-local metadata", metadata: "https://169.254.169.254/private" },
    { name: "IPv4-mapped loopback", metadata: "https://[::ffff:127.0.0.1]/private" },
    { name: "encoded loopback", metadata: "https://2130706433/private" },
    { name: "private DNS", metadata: "https://private.example/private" },
  ])("does not follow an upstream's $name metadata URL", async ({ metadata }) => {
    await using config = await configuration({ type: "remote", url: upstream, oauth: {} });
    const memory = memoryCredentials();

    using lookup = spyOn(dns, "lookup").mockImplementation(async (hostname) => [
      { address: hostname === "private.example" ? "192.168.1.1" : "8.8.8.8", family: 4, ttl: 0 },
    ]);

    using network = spyOn(globalThis, "fetch").mockImplementation(
      fetchImplementation(
        async () =>
          new Response(null, {
            status: 401,
            headers: { "WWW-Authenticate": `Bearer resource_metadata="${metadata}"` },
          }),
      ),
    );

    const result = await login(config.path, {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "invalid" } });
    expect(network).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalled();
    expect(memory.writes).toBe(0);
  });

  test("rejects a delegated private authorization server before contacting it", async () => {
    await using config = await configuration({ type: "remote", url: upstream, oauth: {} });
    const memory = memoryCredentials();

    using lookup = spyOn(dns, "lookup").mockResolvedValue([
      { address: "8.8.8.8", family: 4, ttl: 0 },
    ]);

    using network = spyOn(globalThis, "fetch").mockImplementation(
      fetchImplementation(async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.pathname === "/mcp")
          return new Response(null, {
            status: 401,
            headers: {
              "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.example/metadata"',
            },
          });

        return Response.json({ resource: upstream, authorization_servers: ["https://127.0.0.1"] });
      }),
    );

    const result = await login(config.path, {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "invalid" } });
    expect(network).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenCalled();
    expect(memory.writes).toBe(0);
  });

  test.each(["authorization_endpoint", "token_endpoint", "registration_endpoint"])(
    "rejects a private %s before registration or browser consent",
    async (endpoint) => {
      await using config = await configuration({ type: "remote", url: upstream, oauth: {} });
      const memory = memoryCredentials();

      using lookup = spyOn(dns, "lookup").mockResolvedValue([
        { address: "8.8.8.8", family: 4, ttl: 0 },
      ]);

      using network = spyOn(globalThis, "fetch").mockImplementation(
        fetchImplementation(async (input) => {
          const url = new URL(input instanceof Request ? input.url : input);
          if (url.pathname === "/mcp")
            return new Response(null, {
              status: 401,
              headers: {
                "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.example/metadata"',
              },
            });

          if (url.pathname === "/metadata")
            return Response.json({ resource: upstream, authorization_servers: [issuer] });

          return Response.json({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            registration_endpoint: `${issuer}/register`,
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
            [endpoint]: "https://127.0.0.1/private",
          });
        }),
      );

      const presented: URL[] = [];

      const result = await login(config.path, {
        store: () => memory.store,
        lockDirectory: config.lockDirectory,
        authorize: async (url) => {
          presented.push(url);
        },
      });

      expect(result).toMatchObject({ ok: false, error: { kind: "invalid" } });
      expect(network).toHaveBeenCalledTimes(3);
      expect(lookup).toHaveBeenCalled();
      expect(presented).toEqual([]);
      expect(memory.writes).toBe(0);
    },
  );

  test.each([
    { name: "IPv4", answer: { address: "8.8.8.8", family: 4, ttl: 0 }, pinned: "8.8.8.8" },
    {
      name: "IPv6",
      answer: { address: "2001:4860:4860::8888", family: 6, ttl: 0 },
      pinned: "[2001:4860:4860::8888]",
    },
  ])(
    "pins approved $name while preserving the original HTTP and TLS identities",
    async ({ answer, pinned }) => {
      await using config = await configuration({ type: "remote", url: upstream, oauth: {} });
      const memory = memoryCredentials();
      const controller = new AbortController();

      using lookup = spyOn(dns, "lookup").mockResolvedValue([answer]);

      const requests: {
        address: string;
        authority: string | null;
        serverName: string | undefined;
        verified: boolean | undefined;
      }[] = [];

      using network = spyOn(globalThis, "fetch").mockImplementation(
        fetchImplementation(async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input);

          const tls = z
            .object({ serverName: z.string(), rejectUnauthorized: z.boolean() })
            .parse(init !== undefined && "tls" in init ? init.tls : undefined);

          requests.push({
            address: url.hostname,
            authority: new Headers(init?.headers).get("host"),
            serverName: tls.serverName,
            verified: tls.rejectUnauthorized,
          });
          if (url.pathname === "/mcp")
            return new Response(null, {
              status: 401,
              headers: {
                "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.example/metadata"',
              },
            });

          if (url.pathname === "/metadata")
            return Response.json({ resource: upstream, authorization_servers: [issuer] });

          if (url.pathname === "/register") {
            if (typeof init?.body !== "string") throw new Error("Missing registration JSON");

            const body: unknown = JSON.parse(init.body);
            if (typeof body !== "object" || body === null)
              throw new Error("Invalid registration JSON");

            return Response.json({ ...body, client_id: "synthetic-client" }, { status: 201 });
          }

          return Response.json({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            registration_endpoint: `${issuer}/register`,
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          });
        }),
      );

      const result = await login(config.path, {
        store: () => memory.store,
        lockDirectory: config.lockDirectory,
        signal: controller.signal,
        authorize: async () => {
          controller.abort();
        },
      });

      expect(result).toMatchObject({ ok: false, error: { kind: "cancelled" } });
      expect(lookup).toHaveBeenCalled();
      expect(network).toHaveBeenCalledTimes(4);
      expect(requests).toEqual([
        { address: pinned, authority: "mcp.example", serverName: "mcp.example", verified: true },
        { address: pinned, authority: "mcp.example", serverName: "mcp.example", verified: true },
        { address: pinned, authority: "auth.example", serverName: "auth.example", verified: true },
        { address: pinned, authority: "auth.example", serverName: "auth.example", verified: true },
      ]);
    },
  );

  test("cancellation stops waiting for DNS and a late answer cannot start HTTP", async () => {
    await using config = await configuration({ type: "remote", url: upstream, oauth: {} });
    const memory = memoryCredentials();
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<Bun.DNSLookup[]>();

    using lookup = spyOn(dns, "lookup").mockImplementation(async () => {
      started.resolve();

      return answer.promise;
    });

    using network = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Unexpected HTTP request"),
    );

    const pending = login(config.path, {
      store: () => memory.store,
      lockDirectory: config.lockDirectory,
      signal: controller.signal,
    });

    await started.promise;
    controller.abort();
    const result = await pending;
    answer.resolve([{ address: "8.8.8.8", family: 4, ttl: 0 }]);
    await answer.promise;

    expect(result).toMatchObject({ ok: false, error: { kind: "cancelled" } });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(network).not.toHaveBeenCalled();
    expect(memory.writes).toBe(0);
  });
});
