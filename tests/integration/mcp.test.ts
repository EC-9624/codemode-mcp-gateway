import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ProtocolError, ProtocolErrorCode, Server } from "@modelcontextprotocol/server";
import { Buffer } from "node:buffer";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createMcpServer } from "../../examples/mcp-tools";
import { createDiscoveryTools, createMcpCatalog, execute } from "../../src/sandbox";
import { connectMcp } from "../support/mcp";
import { rejectionOf } from "../support/rejection";

describe("MCP sandbox integration", () => {
  test("discovers and calls a stdio tool, retaining its public response", async () => {
    await using upstream = mcpProcess();
    await upstream.client.connect(upstream.transport, { timeout: 2000 });
    const catalog = await createMcpCatalog(upstream.client);
    const discovery = createDiscoveryTools(catalog);

    const report = await execute(
      `
      const matches = await tools.searchTools({ query: "Add numbers" });
      const tool = await tools.describeTool({ name: matches[0].name });
      const response = await tools[tool.name]({ a: 2, b: 3 });
      return response.structuredContent.sum;
    `,
      { ...catalog.tools, ...discovery },
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
    await using upstream = mcpProcess();
    await upstream.client.connect(upstream.transport, { timeout: 2000 });
    const catalog = await createMcpCatalog(upstream.client);

    const report = await execute(
      `
      const response = await tools.dataset({ count: 3000 });
      return response.structuredContent.records.filter(row => row.id % 2 === 0).length;
    `,
      catalog.tools,
      { maxOutputBytes: 4 },
    );

    expect(report.result).toEqual({ ok: true, value: 1500 });
    expect(report.calls).toHaveLength(1);
    const call = report.calls[0];
    if (call?.status !== "completed" || !call.result.ok)
      throw new Error("Expected completed dataset response");

    expect(Buffer.byteLength(call.result.json ?? "")).toBeGreaterThan(256 * 1024);
  });

  test("resolves explicit MCP errors and server argument-validation errors as data", async () => {
    await using connection = await connectMcp(createMcpServer());
    const catalog = await createMcpCatalog(connection.client);

    const report = await execute(
      `
      const explicit = await tools.fail();
      const invalid = await tools.add({ a: "wrong", b: 3 });
      return { explicit, invalid: invalid.isError, message: invalid.content[0].text };
    `,
      catalog.tools,
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

    const report = await execute(
      `
      let message;
      try { await tools.add(null); } catch (error) { message = error.message; }
      return { message, sum: (await tools.add({ a: 1, b: 2 })).structuredContent.sum };
    `,
      catalog.tools,
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

  test("correlates concurrently completed requests and records invocation order", async () => {
    const server = new Server({ name: "ordered", version: "1" }, { capabilities: { tools: {} } });
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const order: number[] = [];
    server.setRequestHandler("tools/list", () => ({
      tools: [{ name: "read", inputSchema: { type: "object" } }],
    }));
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

    const completion = execute(
      "return await Promise.all([tools.read({ id: 1 }), tools.read({ id: 2 })]);",
      catalog.tools,
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
    await using upstream = mcpProcess("invoke");
    await upstream.client.connect(upstream.transport, { timeout: 2000 });
    const catalog = await createMcpCatalog(upstream.client);
    const controller = new AbortController();

    const completion = execute(
      "await tools.add({ a: 1, b: 2 }); return await tools.pending();",
      catalog.tools,
      {
        timeoutMs: 2000,
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
      (
        await execute(
          "return (await tools.add({ a: 4, b: 5 })).structuredContent.sum;",
          catalog.tools,
        )
      ).result,
    ).toEqual({ ok: true, value: 9 });
  });

  test("the guest deadline cancels its stdio request and leaves the shared client usable", async () => {
    await using upstream = mcpProcess("invoke");
    await upstream.client.connect(upstream.transport, { timeout: 2000 });
    const catalog = await createMcpCatalog(upstream.client);

    const report = await execute("return await tools.pending();", catalog.tools, {
      timeoutMs: 200,
    });

    await upstream.waitFor("request-started");
    await upstream.waitFor("request-cancelled");

    expect(report.result).toMatchObject({ ok: false, error: { kind: "timeout" } });
    expect(report.calls).toEqual([
      { callId: 1, name: "pending", status: "interrupted", reason: "timeout" },
    ]);

    const recovery = await execute(
      "return (await tools.add({ a: 4, b: 5 })).structuredContent.sum;",
      catalog.tools,
    );

    expect(recovery.result).toEqual({ ok: true, value: 9 });
  });

  test("keeps the cancellation snapshot when an uncooperative server finishes late", async () => {
    const server = new Server({ name: "late", version: "1" }, { capabilities: { tools: {} } });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const returned = Promise.withResolvers<void>();
    server.setRequestHandler("tools/list", () => ({
      tools: [{ name: "wait", inputSchema: { type: "object" } }],
    }));
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

    const completion = execute("return await tools.wait();", catalog.tools, {
      signal: controller.signal,
    });

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
    const server = new Server({ name: "private", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", () => ({
      tools: [{ name: "read", inputSchema: { type: "object" } }],
    }));
    server.setRequestHandler("tools/call", () => {
      throw new ProtocolError(ProtocolErrorCode.InternalError, "Private upstream details");
    });

    await using connection = await connectMcp(server);
    const catalog = await createMcpCatalog(connection.client);
    const report = await execute("return await tools.read();", catalog.tools);

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
    await using upstream = mcpProcess("invoke");
    await upstream.client.connect(upstream.transport, { timeout: 2000 });
    const catalog = await createMcpCatalog(upstream.client);
    const completion = execute("return await tools.pending();", catalog.tools);
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
    await using upstream = mcpProcess("discovery");
    await upstream.client.connect(upstream.transport, { timeout: 2000 });
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

function mcpProcess(mode?: string) {
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
