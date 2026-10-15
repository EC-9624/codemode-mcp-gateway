import { describe, expect, test } from "bun:test";
import { gatewayProcess } from "./support/gateway-process.ts";
import { rejectionOf } from "./support/rejection.ts";
import { configurationDocument } from "./support/configuration.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

describe("CMG stdio application", () => {
  test("serves a named upstream from XDG configuration with no CLI arguments", async () => {
    await using file = await configurationDocument({});
    const directory = dirname(file.path);
    await Bun.write(
      join(directory, "cmg/config.json"),
      JSON.stringify({
        mcp: {
          servers: {
            math: {
              type: "local",
              command: [
                process.execPath,
                fileURLToPath(new URL("../../../examples/mcp-server.ts", import.meta.url)),
              ],
            },
          },
        },
      }),
    );

    await using app = await gatewayProcess({
      args: [],
      environment: { XDG_CONFIG_HOME: directory },
    });

    await app.client.connect(app.transport, { timeout: 4_000 });
    await app.waitFor('"state":"connected"');

    const response = await app.client.callTool({
      name: "execute",
      arguments: {
        code: 'return (await tools["math.add"]({ a: 20, b: 22 })).structuredContent.sum;',
      },
    });

    app.child.stdin.end();

    expect(response.structuredContent).toMatchObject({
      result: { ok: true, value: 42 },
      calls: [{ name: "math.add" }],
    });
    expect(await app.closed).toEqual({ code: 0, signal: null });
  }, 10_000);

  test("keeps discovery available while a named upstream is still connecting and cancels it on EOF", async () => {
    await using app = await gatewayProcess({
      configuration: {
        mcp: {
          servers: {
            stalled: {
              type: "local",
              command: [
                process.execPath,
                fileURLToPath(new URL("./fixtures/gateway-upstream.ts", import.meta.url)),
                "initialize",
              ],
            },
          },
        },
      },
    });

    await app.client.connect(app.transport, { timeout: 4_000 });
    await app.waitFor("request-started");

    const response = await app.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools.searchTools({ query: "add" });' },
    });

    const pid = app.upstreamPid();
    app.child.stdin.end();

    expect(response.structuredContent).toMatchObject({
      result: {
        ok: true,
        value: { tools: [], servers: [{ name: "stalled", state: "connecting" }] },
      },
    });
    expect(await app.closed).toEqual({ code: 0, signal: null });
    expect(() => process.kill(pid, 0)).toThrow();
  }, 10_000);
  test.each(["legacy", "modern"] as const)(
    "exposes execute over %s MCP and closes the upstream on EOF",
    async (era) => {
      await using app = await gatewayProcess({
        client: {
          versionNegotiation: { mode: era === "legacy" ? "legacy" : { pin: "2026-07-28" } },
        },
      });

      await app.client.connect(app.transport, { timeout: 4_000 });
      await app.waitForConnections(1);
      const listing = await app.client.listTools();
      expect(listing.tools.map((tool) => tool.name)).toEqual(["execute"]);
      expect(listing.tools[0]?.description).toContain("## Workflow");
      expect(listing.tools[0]?.description).toContain("## Availability");

      const execution = await app.client.callTool({
        name: "execute",
        arguments: {
          code: 'return (await tools["test.add"]({ a: 2, b: 3 })).structuredContent.sum;',
        },
      });

      expect(execution.structuredContent).toEqual({
        result: { ok: true, value: 5 },
        calls: [{ callId: 1, name: "test.add", status: "completed" }],
      });
      const upstream = app.upstreamPid();
      app.child.stdin.end();

      expect(await app.closed).toEqual({ code: 0, signal: null });
      expect(app.stderr).toContain("upstream-exit");
      expect(() => process.kill(upstream, 0)).toThrow();
    },
    10_000,
  );

  test.each(["SIGINT", "SIGTERM"] as const)(
    "cancels an active upstream call and awaits child exit after %s",
    async (signal) => {
      await using app = await gatewayProcess();
      await app.client.connect(app.transport, { timeout: 4_000 });
      await app.waitForConnections(1);

      const request = rejectionOf(
        app.client.callTool({
          name: "execute",
          arguments: { code: 'return await tools["test.pending"]({});' },
        }),
      );

      await app.waitFor("request-started");
      const upstream = app.upstreamPid();

      app.child.kill(signal);
      await request;

      expect(await app.closed).toEqual({ code: 0, signal: null });
      expect(() => process.kill(upstream, 0)).toThrow();
      expect(app.stderr).toContain("upstream-exit");
    },
    10_000,
  );

  test("cancels an active upstream call and awaits child exit after EOF", async () => {
    await using app = await gatewayProcess();
    await app.client.connect(app.transport, { timeout: 4_000 });
    await app.waitForConnections(1);

    const request = rejectionOf(
      app.client.callTool({
        name: "execute",
        arguments: { code: 'return await tools["test.pending"]({});' },
      }),
    );

    await app.waitFor("request-started");
    const upstream = app.upstreamPid();

    app.child.stdin.end();
    await request;

    expect(await app.closed).toEqual({ code: 0, signal: null });
    expect(() => process.kill(upstream, 0)).toThrow();
    expect(app.stderr).toContain("upstream-exit");
  }, 10_000);

  test("interrupts busy guest computation and awaits child exit after EOF", async () => {
    await using app = await gatewayProcess();
    await app.client.connect(app.transport, { timeout: 4_000 });
    await app.waitForConnections(1);

    const request = rejectionOf(
      app.client.callTool({
        name: "execute",
        arguments: { code: 'tools["test.started"]({}); while (true) {}' },
      }),
    );

    await app.waitFor("request-started");
    const upstream = app.upstreamPid();

    app.child.stdin.end();
    await request;

    expect(await app.closed).toEqual({ code: 0, signal: null });
    expect(() => process.kill(upstream, 0)).toThrow();
    expect(app.stderr).toContain("upstream-exit");
  }, 10_000);

  test.each(["initialize", "discovery"])(
    "cancels startup on EOF during %s",
    async (mode) => {
      await using app = await gatewayProcess({ mode });
      await app.client.connect(app.transport, { timeout: 4_000 });
      await app.waitFor("request-started");
      const upstream = app.upstreamPid();
      app.child.stdin.end();

      expect(await app.closed).toEqual({ code: 0, signal: null });
      expect(() => process.kill(upstream, 0)).toThrow();
    },
    10_000,
  );

  test("releases an upstream with an invalid catalog while keeping the gateway available", async () => {
    await using app = await gatewayProcess({ mode: "invalid-schema" });
    await app.client.connect(app.transport, { timeout: 4_000 });
    await app.waitFor('"state":"failed"');
    const upstream = app.upstreamPid();

    expect(() => process.kill(upstream, 0)).toThrow();
    expect(app.stderr).toContain("Upstream tool discovery failed.");
    expect(await app.client.ping()).toEqual({});
    app.child.stdin.end();
    expect(await app.closed).toEqual({ code: 0, signal: null });
  }, 10_000);

  test("rejects invalid configuration before spawning the upstream", async () => {
    await using app = await gatewayProcess({ sandbox: { timeoutMs: 0 } });
    await rejectionOf(app.client.connect(app.transport, { timeout: 4_000 }));

    expect(await app.closed).toEqual({ code: 1, signal: null });
    expect(app.stderr).toContain("Invalid CMG configuration");
    expect(app.stderr).not.toContain("upstream-pid:");
  }, 10_000);

  test("applies the configured source limit before execution", async () => {
    await using app = await gatewayProcess({ sandbox: { maxSourceBytes: 1 } });
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
