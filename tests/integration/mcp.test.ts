import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { Buffer } from "node:buffer";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createMcpServer } from "../../examples/mcp-tools";
import { createDiscoveryTools, CodemodeSandbox } from "../../src/codemode";
import { createMcpCatalog } from "../../src/mcp";
import { connectMcp, toolServer } from "../support/mcp";
import { rejectionOf } from "../support/rejection";

describe("MCP sandbox integration", () => {
  test("discovers and calls a stdio tool, retaining its public response", async () => {
    await using upstream = await connectMcpProcess();
    const catalog = await createMcpCatalog(upstream.client);
    const discovery = createDiscoveryTools(catalog);

    const report = await new CodemodeSandbox({ tools: { ...catalog.tools, ...discovery } }).execute(
      `
      const matches = await tools.searchTools({ query: "Add numbers" });
      const tool = await tools.describeTool({ name: matches[0].name });
      const response = await tools[tool.name]({ a: 2, b: 3 });
      return response.structuredContent.sum;
    `,
    );

    expect(report.result).toEqual({ ok: true, value: 5 });
    expect(report.calls).toHaveLength(3);
    expect(report.calls[2]).toEqual({
      callId: 3,
      name: "add",
      status: "completed",
      result: {
        ok: true,
        json: '{"content":[{"type":"text","text":"{\\"sum\\":5}"}],"structuredContent":{"sum":5}}',
      },
    });
    const pid = upstream.transport.pid;
    expect(pid).toBeNumber();
    await upstream.client.close();
    if (pid === null) throw new Error("Missing child PID");

    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("allows a large upstream dataset to become small final guest output", async () => {
    await using upstream = await connectMcpProcess();
    const catalog = await createMcpCatalog(upstream.client);

    const report = await new CodemodeSandbox({ tools: catalog.tools, maxOutputBytes: 4 }).execute(
      `
      const response = await tools.dataset({ count: 3000 });
      return response.structuredContent.records.filter(row => row.id % 2 === 0).length;
    `,
    );

    expect(report.result).toEqual({ ok: true, value: 1500 });
    expect(report.calls).toHaveLength(1);
    const call = report.calls[0];
    if (call?.status !== "completed" || !call.result.ok)
      throw new Error("Expected completed dataset response");

    expect(Buffer.byteLength(call.result.json ?? "")).toBeGreaterThan(256 * 1024);
  });

  test("resolves explicit MCP errors and stricter server-side validation errors as data", async () => {
    const server = createMcpServer();
    // A server may enforce rules beyond the schema it advertises to the client.
    server.server.setRequestHandler("tools/list", () => ({
      tools: [
        { name: "add", inputSchema: { type: "object" } },
        { name: "fail", inputSchema: { type: "object" } },
      ],
    }));

    await using connection = await connectMcp(server);
    const catalog = await createMcpCatalog(connection.client);

    const report = await new CodemodeSandbox({ tools: catalog.tools }).execute(
      `
      const explicit = await tools.fail();
      const invalid = await tools.add({ a: "wrong", b: 3 });
      return { explicit, invalid: invalid.isError, message: invalid.content[0].text };
    `,
    );

    expect(report.result).toMatchObject({
      ok: true,
      value: {
        explicit: { content: [{ type: "text", text: "Synthetic tool failure." }], isError: true },
        invalid: true,
      },
    });
    expect(JSON.stringify(report.result)).toContain("Input validation error");
    expect(report.calls).toHaveLength(2);
    expect(report.calls.every((call) => call.status === "completed" && call.result.ok)).toBe(true);
  });

  test("rejects invalid object shape in the guest and allows a subsequent valid call", async () => {
    await using connection = await connectMcp(createMcpServer());
    const catalog = await createMcpCatalog(connection.client);

    const report = await new CodemodeSandbox({ tools: catalog.tools }).execute(
      `
      let message;
      try { await tools.add(null); } catch (error) { message = error.message; }
      return { message, sum: (await tools.add({ a: 1, b: 2 })).structuredContent.sum };
    `,
    );

    expect(report.result).toEqual({
      ok: true,
      value: { message: "MCP tool arguments must be an object.", sum: 3 },
    });
    expect(report.calls[0]).toEqual({
      callId: 1,
      name: "add",
      status: "completed",
      result: { ok: false, error: { message: "MCP tool arguments must be an object." } },
    });
  });

  test("retains local MCP schema failures as rejections and sends only corrected arguments upstream", async () => {
    const server = toolServer([
      {
        name: "read",
        inputSchema: {
          type: "object",
          properties: { id: { type: "integer" } },
          required: ["id"],
        },
      },
    ]);

    const received: unknown[] = [];
    server.setRequestHandler("tools/call", ({ params }) => {
      received.push(params.arguments);

      return { content: [], structuredContent: params.arguments };
    });

    await using connection = await connectMcp(server);
    const catalog = await createMcpCatalog(connection.client);

    const report = await new CodemodeSandbox({ tools: catalog.tools }).execute(
      `
      let message;
      try { await tools.read({ id: "1" }); } catch (error) { message = error.message; }
      return { message, response: await tools.read({ id: 1 }) };
    `,
    );

    expect(received).toEqual([{ id: 1 }]);
    expect(report.result).toEqual({
      ok: true,
      value: {
        message: 'Invalid arguments for "read": /id must be integer.',
        response: { content: [], structuredContent: { id: 1 } },
      },
    });
    expect(report.calls[0]).toEqual({
      callId: 1,
      name: "read",
      status: "completed",
      result: {
        ok: false,
        error: { message: 'Invalid arguments for "read": /id must be integer.' },
      },
    });
  });

  test("correlates concurrently completed requests and records invocation order", async () => {
    const server = toolServer([{ name: "read", inputSchema: { type: "object" } }]);
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const order: number[] = [];
    server.setRequestHandler("tools/call", async ({ params }) => {
      if (params.arguments?.id === 1) {
        first.resolve();
        await release.promise;
        order.push(1);

        return { content: [], structuredContent: { id: 1 } };
      }

      order.push(2);
      second.resolve();

      return { content: [], structuredContent: { id: 2 } };
    });

    await using connection = await connectMcp(server);
    using cleanup = new DisposableStack();
    cleanup.defer(() => release.resolve());
    const catalog = await createMcpCatalog(connection.client);

    const completion = new CodemodeSandbox({ tools: catalog.tools }).execute(
      "return await Promise.all([tools.read({ id: 1 }), tools.read({ id: 2 })]);",
    );

    await Promise.all([first.promise, second.promise]);
    release.resolve();
    const report = await completion;

    expect(order).toEqual([2, 1]);
    expect(report.result).toEqual({
      ok: true,
      value: [
        { content: [], structuredContent: { id: 1 } },
        { content: [], structuredContent: { id: 2 } },
      ],
    });
    expect(report.calls).toEqual([
      {
        callId: 1,
        name: "read",
        status: "completed",
        result: { ok: true, json: '{"content":[],"structuredContent":{"id":1}}' },
      },
      {
        callId: 2,
        name: "read",
        status: "completed",
        result: { ok: true, json: '{"content":[],"structuredContent":{"id":2}}' },
      },
    ]);
  });

  test("cancellation reaches the stdio handler and leaves the shared client usable", async () => {
    await using upstream = await connectMcpProcess("invoke");
    const catalog = await createMcpCatalog(upstream.client);
    const controller = new AbortController();

    const sandbox = new CodemodeSandbox({ tools: catalog.tools, timeoutMs: 2000 });

    const completion = sandbox.execute(
      "await tools.add({ a: 1, b: 2 }); return await tools.pending();",
      {
        signal: controller.signal,
      },
    );

    await upstream.waitFor("request-started");
    controller.abort(new Error("Private caller reason"));

    const report = await completion;
    await upstream.waitFor("request-cancelled");

    expect(report.result).toMatchObject({ ok: false, error: { kind: "cancelled" } });
    expect(report.calls[0]).toMatchObject({ name: "add", status: "completed" });
    expect(report.calls[1]).toEqual({
      callId: 2,
      name: "pending",
      status: "interrupted",
      reason: "cancelled",
    });
    expect(
      (await sandbox.execute("return (await tools.add({ a: 4, b: 5 })).structuredContent.sum;"))
        .result,
    ).toEqual({ ok: true, value: 9 });
  });

  test("the guest deadline cancels its stdio request and leaves the shared client usable", async () => {
    await using upstream = await connectMcpProcess("invoke");
    const catalog = await createMcpCatalog(upstream.client);

    const sandbox = new CodemodeSandbox({ tools: catalog.tools, timeoutMs: 200 });
    const report = await sandbox.execute("return await tools.pending();");

    await upstream.waitFor("request-started");
    await upstream.waitFor("request-cancelled");

    expect(report.result).toMatchObject({ ok: false, error: { kind: "timeout" } });
    expect(report.calls).toEqual([
      { callId: 1, name: "pending", status: "interrupted", reason: "timeout" },
    ]);

    const recovery = await sandbox.execute(
      "return (await tools.add({ a: 4, b: 5 })).structuredContent.sum;",
    );

    expect(recovery.result).toEqual({ ok: true, value: 9 });
  });

  test("keeps the cancellation snapshot when an uncooperative server finishes late", async () => {
    const server = toolServer([{ name: "wait", inputSchema: { type: "object" } }]);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const returned = Promise.withResolvers<void>();
    server.setRequestHandler("tools/call", async () => {
      started.resolve();
      await release.promise;
      returned.resolve();

      return { content: [], structuredContent: { late: true } };
    });

    await using connection = await connectMcp(server);
    using cleanup = new DisposableStack();
    cleanup.defer(() => release.resolve());
    const catalog = await createMcpCatalog(connection.client);
    const controller = new AbortController();

    const completion = new CodemodeSandbox({ tools: catalog.tools }).execute(
      "return await tools.wait();",
      {
        signal: controller.signal,
      },
    );

    await started.promise;
    controller.abort();
    const report = await completion;
    const snapshot = JSON.stringify(report);
    release.resolve();
    await returned.promise;
    await connection.client.ping();

    expect(report.calls).toEqual([
      { callId: 1, name: "wait", status: "interrupted", reason: "cancelled" },
    ]);
    expect(JSON.stringify(report)).toBe(snapshot);
  });

  test("keeps server protocol-error details out of guest errors and retained failures", async () => {
    const server = toolServer([{ name: "read", inputSchema: { type: "object" } }]);
    server.setRequestHandler("tools/call", () => {
      throw new ProtocolError(ProtocolErrorCode.InternalError, "Private upstream details");
    });

    await using connection = await connectMcp(server);
    const catalog = await createMcpCatalog(connection.client);

    const report = await new CodemodeSandbox({ tools: catalog.tools }).execute(
      "return await tools.read();",
    );

    expect(report).toEqual({
      result: { ok: false, error: { kind: "script", message: "Host tool failed." } },
      calls: [
        {
          callId: 1,
          name: "read",
          status: "completed",
          result: { ok: false, error: { message: "Host tool failed." } },
        },
      ],
    });
  });

  test("reports a dropped connection as a generic tool failure", async () => {
    await using upstream = await connectMcpProcess("invoke");
    const catalog = await createMcpCatalog(upstream.client);

    const completion = new CodemodeSandbox({ tools: catalog.tools }).execute(
      "return await tools.pending();",
    );

    await upstream.waitFor("request-started");
    const pid = upstream.transport.pid;
    if (pid === null) throw new Error("Missing child PID");

    process.kill(pid, "SIGKILL");
    const report = await completion;

    expect(report.result).toEqual({
      ok: false,
      error: { kind: "script", message: "Host tool failed." },
    });
    expect(report.calls[0]).toMatchObject({
      status: "completed",
      result: { ok: false, error: { message: "Host tool failed." } },
    });
  });

  test("closes the actual child after cancellation during initialization", async () => {
    await using upstream = mcpProcess("initialize");
    const controller = new AbortController();

    const setup = rejectionOf(
      upstream.client.connect(upstream.transport, { signal: controller.signal, timeout: 2000 }),
    );

    await upstream.waitFor("request-started");
    const pid = upstream.transport.pid;
    if (pid === null) throw new Error("Missing child PID");

    controller.abort();
    expect((await setup).reason).toBeInstanceOf(Error);
    await upstream.client.close();
    await upstream.closed;

    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("closes the actual child after discovery times out", async () => {
    await using upstream = await connectMcpProcess("discovery");
    const setup = rejectionOf(createMcpCatalog(upstream.client, { timeoutMs: 100 }));
    await upstream.waitFor("request-started");
    const pid = upstream.transport.pid;
    if (pid === null) throw new Error("Missing child PID");

    expect((await setup).reason).toBeInstanceOf(Error);
    await upstream.client.close();
    await upstream.closed;

    expect(() => process.kill(pid, 0)).toThrow();
  });
});

type McpProcessMode = "invoke" | "initialize" | "discovery";

/** Spawns the example server, or the lifecycle fixture in `mode`, with an unconnected client. */
function mcpProcess(mode?: McpProcessMode) {
  const file =
    mode === undefined
      ? new URL("../../examples/mcp-server.ts", import.meta.url)
      : new URL("../fixtures/mcp-lifecycle-server.ts", import.meta.url);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(file), ...(mode === undefined ? [] : [mode])],
    stderr: "pipe",
  });

  const stderr = transport.stderr;
  if (stderr === null) throw new Error("Expected piped stderr");

  let output = "";

  const onData = (chunk: unknown) => {
    if (!Buffer.isBuffer(chunk)) throw new Error("Expected stderr bytes");

    output += chunk.toString("utf8");
  };

  stderr.on("data", onData);
  const client = new Client({ name: "stdio-test", version: "1" });
  const closed = Promise.withResolvers<void>();
  transport.onclose = () => closed.resolve();

  return {
    client,
    transport,
    closed: closed.promise,
    async waitFor(marker: string) {
      const signal = AbortSignal.timeout(2000);
      while (!output.includes(`${marker}\n`)) {
        await once(stderr, "data", { signal });
      }
    },
    async [Symbol.asyncDispose]() {
      await using cleanup = new AsyncDisposableStack();
      cleanup.defer(() => {
        stderr.off("data", onData);
      });
      cleanup.defer(() => transport.close());
      cleanup.defer(() => client.close());
    },
  };
}

/** Ownership passes to the caller only after the handshake succeeds. */
async function connectMcpProcess(mode?: McpProcessMode) {
  await using cleanup = new AsyncDisposableStack();
  const upstream = cleanup.use(mcpProcess(mode));
  await upstream.client.connect(upstream.transport, { timeout: 2000 });
  cleanup.move();

  return upstream;
}
