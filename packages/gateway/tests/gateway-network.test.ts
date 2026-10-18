import { describe, expect, spyOn, test } from "bun:test";
import { dns } from "bun";
import { setImmediate } from "node:timers/promises";
import { Configuration, Gateway } from "codemode-mcp-gateway";
import { connect, within } from "./support/gateway.ts";
import { fetchImplementation } from "./support/network.ts";
import { memoryCredentials, oauthFixture } from "./support/oauth.ts";
import { responseValue } from "./support/output.ts";

describe("gateway OAuth network recovery", () => {
  test.each(["discovery request", "endpoint validation"] as const)(
    "%s DNS timeout recovers with unchanged credentials and ignores a late answer",
    async (stage) => {
      let available = false;

      await using upstream = await oauthFixture({
        auth: async (request) => {
          if (available) return;

          const path = new URL(request.url).pathname;
          if (stage === "discovery request" && path === "/metadata")
            return Response.json({
              resource: upstream.url,
              authorization_servers: ["https://auth.example"],
            });

          if (stage === "endpoint validation" && path === "/.well-known/oauth-authorization-server")
            return Response.json({
              issuer: upstream.issuer,
              authorization_endpoint: "https://auth.example/authorize",
              token_endpoint: new URL("/token", upstream.url).href,
              registration_endpoint: new URL("/register", upstream.url).href,
              response_types_supported: ["code"],
              code_challenge_methods_supported: ["S256"],
            });
        },
      });

      const memory = memoryCredentials(upstream.credentials());
      const blocked = Promise.withResolvers<void>();
      const answer = Promise.withResolvers<Bun.DNSLookup[]>();
      const expired = new AbortController();
      const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);

      using timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
        ms === 15_000 ? expired.signal : nativeTimeout(ms),
      );

      using lookup = spyOn(dns, "lookup").mockImplementation(async () => {
        blocked.resolve();

        return answer.promise;
      });

      const fetch = globalThis.fetch;
      const remoteRequests: string[] = [];

      using network = spyOn(globalThis, "fetch").mockImplementation(
        fetchImplementation(async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input);
          if (url.hostname !== "127.0.0.1") {
            remoteRequests.push(url.href);
            throw new Error("Unexpected non-fixture request");
          }

          return fetch(input, init);
        }),
      );

      const now = Date.now();
      using clock = spyOn(Date, "now").mockReturnValue(now);
      const recovered = Promise.withResolvers<void>();

      await using gateway = new Gateway(
        Configuration.parse({
          mcp: { servers: { notes: { type: "remote", url: upstream.url, oauth: {} } } },
        }),
        ".",
        {
          store: () => memory.store,
          lockDirectory: upstream.lockDirectory,
          onStatus: (status) => {
            if (status.state === "connected") recovered.resolve();
          },
        },
      );

      const starting = gateway.start();
      await within(blocked.promise);
      expired.abort(new DOMException("Synthetic OAuth network timeout", "TimeoutError"));
      await within(starting, 500);

      expect(gateway.status()).toMatchObject([{ state: "failed", error: { kind: "unavailable" } }]);
      answer.resolve([{ address: "8.8.8.8", family: 4, ttl: 0 }]);
      await setImmediate();
      expect(remoteRequests).toEqual([]);
      expect(upstream.requests.filter((request) => request.method === "POST")).toHaveLength(0);

      available = true;
      timeout.mockRestore();
      clock.mockReturnValue(now + 60_000);
      await within(recovered.promise);
      await using agent = await connect(gateway.createServer());

      const response = await agent.client.callTool({
        name: "execute",
        arguments: {
          code: 'return (await tools["notes.add"]({ a: 2, b: 3 })).structuredContent.sum;',
        },
      });

      expect(responseValue(response)).toBe(5);
      expect(memory.writes).toBe(0);
      expect(upstream.refreshes).toBe(0);
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(network).toHaveBeenCalled();
    },
    10_000,
  );
});
