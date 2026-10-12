import { describe, expect, test } from "bun:test";
import { mcmProcess } from "../support/mcm-process";
import { rejectionOf } from "../support/rejection";

describe("MCM stdio application", () => {
  test.each(["legacy", "modern"] as const)(
    "serves discovery and execution over %s MCP",
    async (era) => {
      await using app = await mcmProcess({
        client: {
          versionNegotiation: { mode: era === "legacy" ? "legacy" : { pin: "2026-07-28" } },
        },
      });

      await app.client.connect(app.transport, { timeout: 4_000 });
      const listing = await app.client.listTools();
      expect(listing.tools.map((tool) => tool.name)).toEqual(["execute"]);

      const discovery = await app.client.callTool({
        name: "execute",
        arguments: { code: 'return await tools.searchTools({ query: "Add numbers" });' },
      });

      expect(discovery.structuredContent).toMatchObject({
        result: { ok: true, value: [{ name: "add", inputSchema: { required: ["a", "b"] } }] },
      });

      const execution = await app.client.callTool({
        name: "execute",
        arguments: { code: "return (await tools.add({ a: 2, b: 3 })).structuredContent.sum;" },
      });

      expect(execution.structuredContent).toEqual({
        result: { ok: true, value: 5 },
        calls: [{ callId: 1, name: "add", status: "completed" }],
      });
      const upstream = app.upstreamPid();
      app.child.stdin.end();

      expect(await app.closed).toEqual({ code: 0, signal: null });
      expect(app.stderr).toContain("upstream-exit");
      expect(() => process.kill(upstream, 0)).toThrow();
    },
    10_000,
  );

  test.each([
    ["EOF during an upstream call", "return await tools.pending();", "eof"],
    ["SIGTERM during an upstream call", "return await tools.pending();", "signal"],
    ["EOF during guest computation", "tools.started(); while (true) {}", "eof"],
  ] as const)(
    "cleans up after %s",
    async (_name, code, stop) => {
      await using app = await mcmProcess();
      await app.client.connect(app.transport, { timeout: 4_000 });
      const request = rejectionOf(app.client.callTool({ name: "execute", arguments: { code } }));
      await app.waitFor("request-started");
      const upstream = app.upstreamPid();
      if (stop === "signal") app.child.kill("SIGTERM");
      else app.child.stdin.end();

      await request;
      expect(await app.closed).toEqual({ code: 0, signal: null });
      expect(() => process.kill(upstream, 0)).toThrow();
      expect(app.stderr).toContain("upstream-exit");
    },
    10_000,
  );

  test.each(["initialize", "discovery"])(
    "cancels startup on EOF during %s",
    async (mode) => {
      await using app = await mcmProcess({ mode });
      const connection = rejectionOf(app.client.connect(app.transport, { timeout: 4_000 }));
      await app.waitFor("request-started");
      const upstream = app.upstreamPid();
      app.child.stdin.end();

      await connection;
      expect(await app.closed).toEqual({ code: 0, signal: null });
      expect(() => process.kill(upstream, 0)).toThrow();
    },
    10_000,
  );

  test.each([
    ["invalid-schema", "Upstream tool discovery failed."],
    ["collision", 'Upstream tool "searchTools" conflicts with an MCM discovery helper.'],
  ])(
    "releases the upstream after %s startup failure",
    async (mode, message) => {
      await using app = await mcmProcess({ mode });
      const connection = rejectionOf(app.client.connect(app.transport, { timeout: 4_000 }));
      await app.waitFor("upstream-pid:");
      const upstream = app.upstreamPid();

      await connection;
      expect(await app.closed).toEqual({ code: 1, signal: null });
      expect(() => process.kill(upstream, 0)).toThrow();
      expect(app.stderr).toContain(message);
    },
    10_000,
  );

  test("rejects invalid configuration before spawning the upstream", async () => {
    await using app = await mcmProcess({ sandbox: { timeoutMs: 0 } });
    await rejectionOf(app.client.connect(app.transport, { timeout: 4_000 }));

    expect(await app.closed).toEqual({ code: 1, signal: null });
    expect(app.stderr).toContain("Invalid MCM configuration");
    expect(app.stderr).not.toContain("upstream-pid:");
  }, 10_000);

  test("applies the configured source limit before execution", async () => {
    await using app = await mcmProcess({ sandbox: { maxSourceBytes: 1 } });
    await app.client.connect(app.transport, { timeout: 4_000 });

    const response = await app.client.callTool({
      name: "execute",
      arguments: { code: "return 42;" },
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      result: { ok: false, error: { kind: "limit", resource: "source", maximum: 1 } },
      calls: [],
    });
  }, 10_000);
});
