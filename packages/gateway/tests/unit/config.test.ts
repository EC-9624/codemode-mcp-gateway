import { describe, expect, test } from "bun:test";
import { Configuration, resolveHeaders } from "../../src/config";

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

  test.each([
    ["unsupported transport", { transport: "sse", url: "https://example.com/mcp" }],
    ["non-HTTP URL", { transport: "http", url: "file:///etc/hosts" }],
    ["invalid URL", { transport: "http", url: "invalid" }],
    ["command on HTTP", { transport: "http", url: "https://example.com/mcp", command: "bun" }],
    ["URL on stdio", { transport: "stdio", command: "bun", url: "https://example.com/mcp" }],
  ])("rejects %s", (_name, upstream) => {
    expect(Configuration.safeParse({ upstream }).success).toBe(false);
  });

  test.each([
    ["null timeout", { timeoutMs: null }],
    ["zero count", { maxToolCalls: 0 }],
    ["fractional size", { memoryLimitBytes: 1.5 }],
    ["overflowing timeout", { totalTimeoutMs: 2 ** 31 }],
    ["oversized stack", { maxStackSizeBytes: 4 * 1024 * 1024 + 1 }],
  ])("rejects %s at the configuration boundary", (_name, sandbox) => {
    expect(Configuration.safeParse({ upstream: { command: "bun" }, sandbox }).success).toBe(false);
  });
});

describe("HTTP header templates", () => {
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
