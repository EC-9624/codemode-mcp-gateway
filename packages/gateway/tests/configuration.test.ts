import { describe, expect, test } from "bun:test";
import { Configuration, resolveHeaders } from "codemode-mcp-gateway";

describe("application configuration", () => {
  test("keeps command-only configurations as stdio upstreams", () => {
    const config = Configuration.parse({ upstream: { command: "bun", args: ["server.ts"] } });

    expect(config.upstream).toEqual({ transport: "stdio", command: "bun", args: ["server.ts"] });
    expect(config.sandbox).toEqual({
      timeoutMs: 5000,
      totalTimeoutMs: 10000,
      memoryLimitBytes: 64 * 1024 * 1024,
      maxStackSizeBytes: 1024 * 1024,
      maxSourceBytes: 256 * 1024,
      maxOutputBytes: 256 * 1024,
      maxToolCalls: 100,
      maxConcurrentToolCalls: 10,
    });
  });

  test("accepts HTTP upstream configuration and host-owned header templates", () => {
    const upstream = {
      transport: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer {env:TOKEN}" },
    } satisfies Configuration["upstream"];

    const config = Configuration.parse({ upstream, sandbox: { maxToolCalls: 2 } });

    expect(config.upstream).toEqual(upstream);
    expect(config.sandbox.maxToolCalls).toBe(2);
  });

  test("accepts explicitly named OAuth connections without static bearer headers", () => {
    const upstream = {
      id: "notion",
      transport: "http",
      url: "https://mcp.notion.com/mcp",
      auth: { type: "oauth", scope: "read" },
    } satisfies Configuration["upstream"];

    expect(Configuration.parse({ upstream }).upstream).toEqual(upstream);
  });

  test.each([
    [
      "missing connection id",
      { transport: "http", url: "https://example.com/mcp", auth: { type: "oauth" } },
    ],
    [
      "competing bearer header",
      {
        id: "test",
        transport: "http",
        url: "https://example.com/mcp",
        headers: { aUtHoRiZaTiOn: "private-token" },
        auth: { type: "oauth" },
      },
    ],
    [
      "cleartext remote endpoint",
      { id: "test", transport: "http", url: "http://example.com/mcp", auth: { type: "oauth" } },
    ],
    [
      "embedded credentials",
      {
        id: "test",
        transport: "http",
        url: "https://user:private@example.com/mcp",
        auth: { type: "oauth" },
      },
    ],
  ])("rejects OAuth %s", (_name, upstream) => {
    expect(Configuration.safeParse({ upstream }).success).toBe(false);
  });

  test("returns a validation failure rather than throwing for malformed OAuth URLs", () => {
    expect(
      Configuration.safeParse({
        upstream: { id: "test", transport: "http", url: "invalid", auth: { type: "oauth" } },
      }).success,
    ).toBe(false);
  });

  test.each([
    ["unsupported transport", { transport: "sse", url: "https://example.com/mcp" }],
    ["non-HTTP URL", { transport: "http", url: "file:///etc/hosts" }],
    ["unknown upstream field", { command: "bun", unexpected: true }],
    [
      "OAuth fragment",
      {
        transport: "http",
        id: "notes",
        url: "https://example.com/mcp#fragment",
        auth: { type: "oauth" },
      },
    ],
  ])("rejects %s", (_name, upstream) => {
    expect(Configuration.safeParse({ upstream }).success).toBe(false);
  });

  test("rejects an invalid sandbox policy at the configuration boundary", () => {
    expect(
      Configuration.safeParse({
        upstream: { command: "bun" },
        sandbox: { maxToolCalls: 0 },
      }).success,
    ).toBe(false);
  });

  test("accepts a loopback HTTP endpoint for local OAuth development", () => {
    const upstream = {
      transport: "http",
      id: "notes",
      url: "http://127.0.0.1:12345/mcp",
      auth: { type: "oauth" },
    } satisfies Configuration["upstream"];

    const result = Configuration.safeParse({ upstream });

    expect(result.success).toBe(true);
    if (!result.success) throw result.error;

    expect(result.data.upstream).toEqual(upstream);
  });

  test("rejects unknown top-level configuration fields", () => {
    const input = { upstream: { command: "bun" }, unexpected: true };

    const result = Configuration.safeParse(input);

    expect(result.success).toBe(false);
  });
});

describe("HTTP header templates", () => {
  test("returns empty headers when no templates are supplied", () => {
    const result = resolveHeaders();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);

    expect([...result.headers]).toEqual([]);
  });

  test("expands environment references as literal values", () => {
    const result = resolveHeaders(
      {
        Authorization: "Bearer {env:TOKEN}",
        "X-Session": "{env:SESSION}:{env:SESSION}",
      },
      { TOKEN: "$&{env:OTHER}", SESSION: "test" },
    );

    if (!result.ok) throw new Error(result.message);

    expect(result.headers.get("Authorization")).toBe("Bearer $&{env:OTHER}");
    expect(result.headers.get("X-Session")).toBe("test:test");
  });

  test("reports missing variables without exposing other header values", () => {
    const result = resolveHeaders({ Authorization: "private-prefix {env:TOKEN}" }, {});

    expect(result).toEqual({
      ok: false,
      message: 'Missing environment variable TOKEN for upstream header "Authorization".',
    });
  });

  test("keeps invalid credential values out of diagnostics", () => {
    const result = resolveHeaders({ Authorization: "{env:TOKEN}" }, { TOKEN: "private\r\nvalue" });

    expect(result).toEqual({ ok: false, message: 'Invalid HTTP upstream header "Authorization".' });
  });
});
