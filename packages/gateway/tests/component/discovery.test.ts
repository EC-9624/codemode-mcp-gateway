import { describe, expect, test } from "bun:test";
import { discoverOAuth } from "../../src/auth/oauth.ts";

describe("OAuth discovery", () => {
  test.each([
    { name: "challenge-advertised metadata", status: 401, metadataPath: "/metadata" },
    {
      name: "well-known metadata without a challenge URL",
      status: 401,
      metadataPath: "/.well-known/oauth-protected-resource/mcp",
    },
    {
      name: "well-known metadata when GET is unsupported",
      status: 405,
      metadataPath: "/.well-known/oauth-protected-resource/mcp",
    },
  ])("resolves $name", async ({ status, metadataPath }) => {
    const requests: Request[] = [];

    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests.push(request);
        const url = new URL(request.url);
        if (url.pathname === "/mcp") {
          return new Response(null, {
            status,
            headers:
              metadataPath === "/metadata"
                ? {
                    "WWW-Authenticate": `Bearer resource_metadata="${new URL(metadataPath, url).href}"`,
                  }
                : {},
          });
        }

        if (url.pathname === metadataPath) {
          return Response.json({
            resource: new URL("/mcp", url).href,
            authorization_servers: [new URL("/issuer", url).href],
          });
        }

        if (url.pathname === "/.well-known/oauth-authorization-server/issuer") {
          return Response.json({
            issuer: new URL("/issuer", url).href,
            authorization_endpoint: new URL("/authorize", url).href,
            token_endpoint: new URL("/token", url).href,
            response_types_supported: ["code"],
          });
        }

        return new Response(null, { status: 404 });
      },
    });

    const url = new URL("/mcp", server.url).href;
    const result = await discoverOAuth({ id: "test", url }, AbortSignal.timeout(5_000));

    expect(result).toMatchObject({
      ok: true,
      value: { issuer: new URL("/issuer", server.url).href, resource: url },
    });
    expect(requests.some((request) => new URL(request.url).pathname === metadataPath)).toBe(true);
    expect(requests[0]?.url).toBe(url);
    expect(requests.every((request) => !request.headers.has("authorization"))).toBe(true);
  });

  test("rejects an insecure challenge URL before fetching metadata", async () => {
    const paths: string[] = [];

    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        paths.push(new URL(request.url).pathname);

        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Bearer resource_metadata="http://insecure.example/metadata"',
          },
        });
      },
    });

    const result = await discoverOAuth(
      { id: "test", url: new URL("/mcp", server.url).href },
      AbortSignal.timeout(5_000),
    );

    expect(result).toMatchObject({ ok: false, error: { kind: "invalid" } });
    expect(paths).toEqual(["/mcp"]);
  });
});
