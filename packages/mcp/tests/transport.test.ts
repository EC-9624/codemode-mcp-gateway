import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { McpServer, ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { Buffer } from "node:buffer";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { CodeExecutor, type ToolException } from "@cmg/codemode";
import { createMcpCatalog } from "@cmg/mcp";
import { connectMcp, toolServer } from "./support/mcp.ts";
import { rejectionOf } from "./support/rejection.ts";

describe("MCP transport contracts", () => {
  test("discovers and calls a stdio tool, returning its processed value and call summary", async () => {
    await using upstream = await connectMcpProcess();
    const catalog = await createMcpCatalog(upstream.client);

    const report = await new CodeExecutor({ tools: catalog.tools }).execute(
      "return (await tools.add({ a: 2, b: 3 })).structuredContent.sum;",
    );

    expect(report.result).toEqual({ ok: true, value: 5 });
    expect(report.calls).toEqual([
      {
        callId: 1,
        name: "add",
        status: "completed",
      },
    ]);
    const pid = upstream.transport.pid;
    expect(pid).toBeNumber();
    await upstream.client.close();
    await upstream.closed;
    if (pid === null) throw new Error("Missing child PID");

    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("allows a large upstream dataset to become small final guest output", async () => {
    await using upstream = await connectMcpProcess();
    const catalog = await createMcpCatalog(upstream.client);

    const report = await new CodeExecutor({ tools: catalog.tools, maxOutputBytes: 4 }).execute(
      `
      const response = await tools.dataset({ count: 3000 });
      return response.structuredContent.records.filter(row => row.id % 2 === 0).length;
    `,
    );

    expect(report.result).toEqual({ ok: true, value: 1500 });
    expect(report.calls).toEqual([{ callId: 1, name: "dataset", status: "completed" }]);
  });

  test("cancellation reaches the stdio handler and leaves the shared client usable", async () => {
    await using upstream = await connectMcpProcess("invoke");
    const catalog = await createMcpCatalog(upstream.client);
    const controller = new AbortController();

    const sandbox = new CodeExecutor({ tools: catalog.tools, timeoutMs: 2000 });

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

    expect(report.result).toEqual({
      ok: false,
      error: { kind: "cancelled", message: "Execution cancelled." },
    });
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

    const sandbox = new CodeExecutor({ tools: catalog.tools, timeoutMs: 200 });
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
    const server = new McpServer({ name: "uncooperative-upstream", version: "1" });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const returned = Promise.withResolvers<void>();
    server.registerTool("wait", {}, async () => {
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

    const completion = new CodeExecutor({ tools: catalog.tools }).execute(
      "return await tools.wait();",
      {
        signal: controller.signal,
      },
    );

    await started.promise;
    controller.abort();
    const report = await completion;
    expect(report).toEqual({
      result: { ok: false, error: { kind: "cancelled", message: "Execution cancelled." } },
      calls: [{ callId: 1, name: "wait", status: "interrupted", reason: "cancelled" }],
    });
    const snapshot = JSON.stringify(report);
    release.resolve();
    await returned.promise;
    await connection.client.ping();

    expect(JSON.stringify(report)).toBe(snapshot);
  });

  test("exposes server protocol codes and messages while keeping data and original causes host-only", async () => {
    const server = toolServer([{ name: "read", inputSchema: { type: "object" } }]);
    // Tool callbacks turn exceptions into public error data; this test needs a protocol failure.
    server.server.setRequestHandler("tools/call", () => {
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        "Upstream could not read the record.",
        {
          detail: "Host-only data",
        },
      );
    });

    await using connection = await connectMcp(server);
    const catalog = await createMcpCatalog(connection.client);
    const exceptions: ToolException[] = [];

    const report = await new CodeExecutor({
      tools: catalog.tools,
      onToolException: (exception) => exceptions.push(exception),
    }).execute("return await tools.read();");

    expect(report).toEqual({
      result: {
        ok: false,
        error: {
          kind: "script",
          message: 'MCP tool "read" failed (code -32603): Upstream could not read the record.',
        },
      },
      calls: [
        {
          callId: 1,
          name: "read",
          status: "completed",
        },
      ],
    });
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]?.cause).toBeInstanceOf(ProtocolError);
    expect(exceptions[0]?.cause).toMatchObject({
      code: -32603,
      data: { detail: "Host-only data" },
    });
  });

  test("reports a dropped connection as a generic tool failure", async () => {
    await using upstream = await connectMcpProcess("invoke");
    const catalog = await createMcpCatalog(upstream.client);

    const completion = new CodeExecutor({ tools: catalog.tools }).execute(
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
    expect(report.calls).toEqual([{ callId: 1, name: "pending", status: "completed" }]);
  });

  test("the caller closes the actual child after discovery times out", async () => {
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

type McpProcessMode = "invoke" | "discovery";

/** Spawns a package-local upstream fixture with an unconnected client. */
function mcpProcess(mode?: McpProcessMode) {
  const file =
    mode === undefined
      ? new URL("./fixtures/mcp-server.ts", import.meta.url)
      : new URL("./fixtures/mcp-lifecycle-server.ts", import.meta.url);

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
