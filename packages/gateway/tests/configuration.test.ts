import { describe, expect, test } from "bun:test";
import {
  Configuration,
  configurationPath,
  resolveHeaders,
  type ConfigurationInput,
} from "codemode-mcp-gateway";

describe("application configuration", () => {
  test("rejects a prototype-sensitive server name instead of silently dropping it", () => {
    const input: unknown = JSON.parse(`{"mcp":{"servers":{
      "__proto__":{"type":"local","command":["unused"]},
      "normal":{"type":"local","command":["unused"]}
    }}}`);

    const result = Configuration.safeParse(input);

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected invalid server name.");

    expect(result.error.issues).toMatchObject([
      {
        path: ["mcp", "servers", "__proto__"],
        message: 'Server name "__proto__" is not supported.',
      },
    ]);
  });
  test("validates named local and remote entries without changing their transport shape", () => {
    const config = Configuration.parse({
      mcp: {
        servers: {
          local: {
            type: "local",
            command: ["bun", "server.ts"],
            environment: { MODE: "read" },
            cwd: "tools",
          },
          notes: { type: "remote", url: "https://example.com/mcp", oauth: { scope: "read" } },
          paused: { type: "local", command: ["unused"], disabled: true },
        },
      },
    });

    expect(config.mcp.servers).toEqual({
      local: {
        disabled: false,
        type: "local",
        command: ["bun", "server.ts"],
        environment: { MODE: "read" },
        cwd: "tools",
      },
      notes: {
        disabled: false,
        type: "remote",
        url: "https://example.com/mcp",
        oauth: { scope: "read" },
      },
      paused: { disabled: true, type: "local", command: ["unused"] },
    });
  });

  test.each([
    { name: "unnamed upstream", input: { upstream: { command: "bun" } } },
    {
      name: "mixed formats",
      input: {
        upstream: { command: "bun" },
        mcp: { servers: { local: { type: "local", command: ["bun"] } } },
      },
    },
    { name: "empty collection", input: { mcp: { servers: {} } } },
    {
      name: "ambiguous namespace",
      input: { mcp: { servers: { "a.b": { type: "local", command: ["bun"] } } } },
    },
    {
      name: "empty command",
      input: { mcp: { servers: { local: { type: "local", command: [] } } } },
    },
    {
      name: "competing OAuth header",
      input: {
        mcp: {
          servers: {
            notes: {
              type: "remote",
              url: "https://example.com/mcp",
              oauth: {},
              headers: { Authorization: "private" },
            },
          },
        },
      },
    },
  ])("rejects $name", ({ input }) => {
    expect(Configuration.safeParse(input).success).toBe(false);
  });
  test("supplies bounded default sandbox policy", () => {
    const config = Configuration.parse({
      mcp: { servers: { local: { type: "local", command: ["bun", "server.ts"] } } },
    });

    expect(config.sandbox).toEqual({
      timeoutMs: 5000,
      totalTimeoutMs: 10000,
      memoryLimitBytes: 256 * 1024 * 1024,
      maxStackSizeBytes: 1024 * 1024,
      maxSourceBytes: 256 * 1024,
      maxOutputBytes: 256 * 1024,
      maxToolCalls: 100,
      maxConcurrentToolCalls: 10,
      maxConcurrentExecutions: 4,
    });
  });

  test("accepts HTTP upstream configuration and host-owned header templates", () => {
    const upstream = {
      type: "remote",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer {env:TOKEN}" },
    } satisfies ConfigurationInput["mcp"]["servers"][string];

    const config = Configuration.parse({
      mcp: { servers: { notes: upstream } },
      sandbox: { maxToolCalls: 2, maxConcurrentExecutions: 8 },
    });

    expect(config.mcp.servers.notes).toEqual({ ...upstream, disabled: false });
    expect(config.sandbox.maxToolCalls).toBe(2);
    expect(config.sandbox.maxConcurrentExecutions).toBe(8);
  });

  test("accepts explicitly named OAuth connections without static bearer headers", () => {
    const upstream = {
      type: "remote",
      url: "https://mcp.notion.com/mcp",
      oauth: { scope: "read" },
    } satisfies ConfigurationInput["mcp"]["servers"][string];

    expect(
      Configuration.parse({ mcp: { servers: { notion: upstream } } }).mcp.servers.notion,
    ).toEqual({ ...upstream, disabled: false });
  });

  test.each([
    [
      "explicit connection id",
      { type: "remote", id: "other", url: "https://example.com/mcp", oauth: {} },
    ],
    [
      "competing bearer header",
      {
        type: "remote",
        url: "https://example.com/mcp",
        headers: { aUtHoRiZaTiOn: "private-token" },
        oauth: {},
      },
    ],
    ["cleartext remote endpoint", { type: "remote", url: "http://example.com/mcp", oauth: {} }],
    [
      "embedded credentials",
      {
        type: "remote",
        url: "https://user:private@example.com/mcp",
        oauth: {},
      },
    ],
  ])("rejects OAuth %s", (_name, upstream) => {
    expect(Configuration.safeParse({ mcp: { servers: { notes: upstream } } }).success).toBe(false);
  });

  test("returns a validation failure rather than throwing for malformed OAuth URLs", () => {
    expect(
      Configuration.safeParse({
        mcp: { servers: { notes: { type: "remote", url: "invalid", oauth: {} } } },
      }).success,
    ).toBe(false);
  });

  test.each([
    ["unsupported transport", { type: "sse", url: "https://example.com/mcp" }],
    ["non-HTTP URL", { type: "remote", url: "file:///etc/hosts" }],
    ["unknown upstream field", { type: "local", command: ["bun"], unexpected: true }],
    [
      "OAuth fragment",
      {
        type: "remote",
        url: "https://example.com/mcp#fragment",
        oauth: {},
      },
    ],
  ])("rejects %s", (_name, upstream) => {
    expect(Configuration.safeParse({ mcp: { servers: { notes: upstream } } }).success).toBe(false);
  });

  test.each(["maxToolCalls", "maxConcurrentExecutions"])(
    "rejects invalid %s at the configuration boundary",
    (name) => {
      expect(
        Configuration.safeParse({
          mcp: { servers: { local: { type: "local", command: ["bun"] } } },
          sandbox: { [name]: 0 },
        }).success,
      ).toBe(false);
    },
  );

  test("accepts a loopback HTTP endpoint for local OAuth development", () => {
    const upstream = {
      type: "remote",
      url: "http://127.0.0.1:12345/mcp",
      oauth: {},
    } satisfies ConfigurationInput["mcp"]["servers"][string];

    const result = Configuration.safeParse({ mcp: { servers: { notes: upstream } } });

    expect(result.success).toBe(true);
    if (!result.success) throw result.error;

    expect(result.data.mcp.servers.notes).toEqual({ ...upstream, disabled: false });
  });

  test("rejects unknown top-level configuration fields", () => {
    const input = {
      mcp: { servers: { local: { type: "local", command: ["bun"] } } },
      unexpected: true,
    };

    const result = Configuration.safeParse(input);

    expect(result.success).toBe(false);
  });
});

describe("configuration path resolution", () => {
  test("uses XDG configuration independently of the working directory", () => {
    expect(configurationPath(undefined, { XDG_CONFIG_HOME: "/config" }, "/home/test")).toBe(
      "/config/cmg/config.json",
    );
  });
  test("falls back to the home configuration directory", () => {
    expect(configurationPath(undefined, {}, "/home/test")).toBe(
      "/home/test/.config/cmg/config.json",
    );
  });
  test("an explicit absolute path overrides even invalid XDG configuration", () => {
    expect(
      configurationPath("/project/custom.json", { XDG_CONFIG_HOME: "relative" }, "/home/test"),
    ).toBe("/project/custom.json");
  });
  test("rejects relative XDG_CONFIG_HOME instead of changing meaning with cwd", () => {
    expect(() =>
      configurationPath(undefined, { XDG_CONFIG_HOME: "relative" }, "/home/test"),
    ).toThrow("XDG_CONFIG_HOME must be an absolute path");
  });
});

describe("HTTP header templates", () => {
  test.each(["constructor", "toString", "__proto__"])(
    "does not expand inherited %s as an environment variable",
    (name) => {
      expect(resolveHeaders({ "X-Token": `{env:${name}}` }, {})).toEqual({
        ok: false,
        message: `Missing environment variable ${name} for upstream header "X-Token".`,
      });
    },
  );

  test("expands an own environment variable with a prototype-sensitive name", () => {
    const result = resolveHeaders({ "X-Token": "{env:constructor}" }, { constructor: "token" });

    if (!result.ok) throw new Error(result.message);

    expect(result.headers.get("X-Token")).toBe("token");
  });
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
