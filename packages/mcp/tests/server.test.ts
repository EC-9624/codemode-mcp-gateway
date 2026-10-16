import { describe, expect, test } from "bun:test";
import { SandboxExecutionError, type ExecutionReport } from "@codemode-mcp-gateway/codemode";
import { createCodemodeServer } from "@codemode-mcp-gateway/mcp";
import { connectMcp } from "./support/mcp.ts";
import { rejectionOf } from "./support/rejection.ts";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

describe("agent-facing MCP server", () => {
  test("close prevents a received request from starting its executor after shutdown", async () => {
    let executions = 0;

    const server = createCodemodeServer({
      execute: async () => {
        executions++;

        return { result: { ok: true, value: 42 }, calls: [] };
      },
    });

    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => server.close());
    const input = new PassThrough();
    const output = new PassThrough();
    cleanup.defer(() => {
      input.destroy();
      output.destroy();
    });
    server.server.onerror = () => {};

    await server.connect(new StdioServerTransport(input, output));
    const initialized = once(output, "data");
    input.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "close-race", version: "0" },
        },
      }) + "\n",
    );
    await initialized;
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    input.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "execute", arguments: { code: "return 42;" } },
      }) + "\n",
    );
    await server.close();
    await setImmediate();

    expect(executions).toBe(0);
  });
  test.each([
    { name: "a plain string", value: "hello", text: "hello" },
    { name: "an empty string", value: "", text: "" },
    { name: "a boolean", value: false, text: "false" },
    { name: "null", value: null, text: "null" },
    { name: "an object", value: { count: 3 }, text: '{"count":3}' },
    { name: "an array", value: [1, 2], text: "[1,2]" },
  ])("renders $name without the execution envelope", async ({ value, text }) => {
    await using agent = await connectMcp(
      createCodemodeServer({
        execute: async () => ({ result: { ok: true, value }, calls: [] }),
      }),
    );

    const response = await agent.client.callTool({
      name: "execute",
      arguments: { code: "return value" },
    });

    expect(response).toEqual({ content: [{ type: "text", text }] });
  });

  test("keeps unexpected output formatter failures private without replaying execution", async () => {
    let executions = 0;
    const cause = new Error("Private formatting details");
    const diagnostics: Error[] = [];

    const server = createCodemodeServer({
      execute: async () => {
        executions++;

        return { result: { ok: true, value: 42 }, calls: [] };
      },
      formatOutput: async () => {
        throw cause;
      },
    });

    server.server.onerror = (error) => diagnostics.push(error);
    await using agent = await connectMcp(server);

    const response = await agent.client.callTool({
      name: "execute",
      arguments: { code: "return 42" },
    });

    expect(response).toEqual({
      content: [
        { type: "text", text: "Execution completed, but its output could not be displayed." },
      ],
      isError: true,
    });
    expect(executions).toBe(1);
    expect(diagnostics[0]?.cause).toBe(cause);
  });

  test("advertises the application-supplied execute description", async () => {
    const server = createCodemodeServer({
      description: "Run the application's read-only workflow.",
      execute: async () => ({ result: { ok: true, value: null }, calls: [] }),
    });

    await using agent = await connectMcp(server);

    const listing = await agent.client.listTools();

    expect(listing.tools).toHaveLength(1);
    expect(listing.tools[0]?.description).toBe("Run the application's read-only workflow.");
  });

  test("closing one server leaves its borrowed executor usable by another server", async () => {
    const calls: string[] = [];

    const execute = async (code: string): Promise<ExecutionReport> => {
      calls.push(code);

      return { result: { ok: true, value: code }, calls: [] };
    };

    const first = createCodemodeServer({ execute });
    await using firstAgent = await connectMcp(first);
    await using secondAgent = await connectMcp(createCodemodeServer({ execute }));
    expect(await firstAgent.client.ping()).toEqual({});

    await first.close();

    const response = await secondAgent.client.callTool({
      name: "execute",
      arguments: { code: "still available" },
    });

    expect(response).toEqual({ content: [{ type: "text", text: "still available" }] });
    expect(calls).toEqual(["still available"]);
  });

  test("request cancellation reaches the injected executor", async () => {
    const started = Promise.withResolvers<AbortSignal>();
    const stopped = Promise.withResolvers<void>();
    const controller = new AbortController();

    const server = createCodemodeServer({
      execute: async (_code, { signal }) => {
        using listeners = new DisposableStack();
        const stop = () => stopped.resolve();
        signal.addEventListener("abort", stop, { once: true });
        listeners.defer(() => signal.removeEventListener("abort", stop));
        started.resolve(signal);
        await stopped.promise;

        return {
          result: { ok: false, error: { kind: "cancelled", message: "Execution cancelled." } },
          calls: [],
        };
      },
    });

    await using agent = await connectMcp(server);
    using cleanup = new DisposableStack();
    cleanup.defer(() => stopped.resolve());

    const request = rejectionOf(
      agent.client.callTool(
        {
          name: "execute",
          arguments: { code: "wait" },
        },
        { signal: controller.signal },
      ),
    );

    const signal = await started.promise;
    controller.abort();
    await stopped.promise;
    await request;

    expect(signal.aborted).toBe(true);
    expect(await agent.client.ping()).toEqual({});
  });

  test("advertises a strict code-only tool without assuming an execution engine", async () => {
    const server = createCodemodeServer({
      execute: async () => ({ result: { ok: true, value: null }, calls: [] }),
    });

    await using agent = await connectMcp(server);

    const listing = await agent.client.listTools();

    expect(listing.tools).toHaveLength(1);
    expect(listing.tools[0]).toMatchObject({
      name: "execute",
      inputSchema: {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"],
        additionalProperties: false,
      },
    });
    expect(listing.tools[0]?.description).not.toContain("QuickJS");
    expect(listing.tools[0]?.description).not.toContain("searchTools");
  });

  test("passes submitted code and a live signal to the injected executor", async () => {
    const codes: string[] = [];
    const signals: AbortSignal[] = [];

    const server = createCodemodeServer({
      execute: async (code, { signal }) => {
        codes.push(code);
        signals.push(signal);

        return { result: { ok: true, value: code }, calls: [] };
      },
    });

    await using agent = await connectMcp(server);

    const response = await agent.client.callTool({
      name: "execute",
      arguments: { code: "application execution" },
    });

    expect(response).toEqual({ content: [{ type: "text", text: "application execution" }] });
    expect(codes).toEqual(["application execution"]);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
  });

  test.each([
    ["missing code", {}],
    ["non-string code", { code: 42 }],
    ["resource override", { code: "return 42;", timeoutMs: 60_000 }],
  ])("rejects %s before invoking the executor", async (_name, args) => {
    let executions = 0;

    const server = createCodemodeServer({
      execute: async () => {
        executions++;

        return { result: { ok: true, value: 42 }, calls: [] };
      },
    });

    await using agent = await connectMcp(server);

    const response = await agent.client.callTool({ name: "execute", arguments: args });

    expect(response.isError).toBe(true);
    expect(executions).toBe(0);
  });

  test("returns only the value without host bookkeeping or a redundant success flag", async () => {
    const call = {
      callId: 1,
      name: "read",
      status: "completed",
      privateBody: "private payload",
    } as const;

    const report = {
      result: { ok: true, value: 42 },
      calls: [call],
    } satisfies ExecutionReport;

    await using agent = await connectMcp(createCodemodeServer({ execute: async () => report }));

    const response = await agent.client.callTool({ name: "execute", arguments: { code: "read" } });

    expect(response).toEqual({ content: [{ type: "text", text: "42" }] });
    expect(JSON.stringify(response)).not.toContain("private payload");
  });

  test("does not infer execution failure from returned error-shaped data", async () => {
    const report = {
      result: { ok: true, value: { isError: true } },
      calls: [],
    } satisfies ExecutionReport;

    const server = createCodemodeServer({ execute: async () => report });
    await using agent = await connectMcp(server);

    const response = await agent.client.callTool({
      name: "execute",
      arguments: { code: "return data" },
    });

    expect(response).toEqual({ content: [{ type: "text", text: '{"isError":true}' }] });
  });

  test("marks unsuccessful execution reports as errors", async () => {
    const report = {
      result: { ok: false, error: { kind: "script", message: "Script failed" } },
      calls: [],
    } satisfies ExecutionReport;

    await using agent = await connectMcp(createCodemodeServer({ execute: async () => report }));

    const response = await agent.client.callTool({ name: "execute", arguments: { code: "fail" } });

    expect(response.isError).toBe(true);
    expect(response.content).toEqual([{ type: "text", text: "Script failed" }]);
  });

  test("keeps synchronous executor exceptions private", async () => {
    const cause = new Error("Private executor details");

    const server = createCodemodeServer({
      execute: () => {
        throw cause;
      },
    });

    const diagnostics: Error[] = [];
    server.server.onerror = (error) => diagnostics.push(error);
    await using agent = await connectMcp(server);

    const response = await agent.client.callTool({
      name: "execute",
      arguments: { code: "return 42;" },
    });

    expect(response.isError).toBe(true);
    expect(response.content).toEqual([{ type: "text", text: "Sandbox execution failed." }]);
    expect(JSON.stringify(response)).not.toContain("Private executor details");
    expect(diagnostics[0]?.cause).toBe(cause);
  });

  test("keeps infrastructure details and call records host-side", async () => {
    const failure = new SandboxExecutionError(
      [
        {
          callId: 1,
          name: "read",
          status: "completed",
        },
      ],
      new Error("Private worker credentials"),
    );

    let executions = 0;

    const server = createCodemodeServer({
      execute: async () => {
        executions++;

        throw failure;
      },
    });

    const diagnostics: Error[] = [];
    server.server.onerror = (error) => diagnostics.push(error);
    await using agent = await connectMcp(server);

    const response = await agent.client.callTool({ name: "execute", arguments: { code: "read" } });

    expect(response.isError).toBe(true);
    expect(response).toEqual({
      content: [{ type: "text", text: "Sandbox execution failed." }],
      isError: true,
    });
    expect(JSON.stringify(response)).not.toContain("credentials");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.cause).toBe(failure);
    expect(executions).toBe(1);
  });

  test("preserves the controlled failure when diagnostics throw", async () => {
    const failure = new SandboxExecutionError(
      [{ callId: 1, name: "read", status: "interrupted", reason: "sandbox-error" }],
      new Error("Private infrastructure details"),
    );

    let executions = 0;

    const server = createCodemodeServer({
      execute: async () => {
        executions++;

        throw failure;
      },
    });

    server.server.onerror = () => {
      throw new Error("Private diagnostic output");
    };

    await using agent = await connectMcp(server);

    const response = await agent.client.callTool({ name: "execute", arguments: { code: "read" } });

    expect(response.isError).toBe(true);
    expect(response).toEqual({
      content: [{ type: "text", text: "Sandbox execution failed." }],
      isError: true,
    });
    expect(JSON.stringify(response)).not.toContain("Private");
    expect(executions).toBe(1);
  });

  test("close aborts the injected executor and awaits its cleanup", async () => {
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    const events: string[] = [];

    const server = createCodemodeServer({
      onClose: async () => {
        events.push("released presentation resources");
      },
      execute: async (_code, { signal }) => {
        using listeners = new DisposableStack();

        const stop = () => {
          events.push("aborted");
          aborted.resolve();
        };

        signal.addEventListener("abort", stop, { once: true });
        listeners.defer(() => {
          signal.removeEventListener("abort", stop);
          events.push("cleaned up");
        });
        started.resolve();
        await aborted.promise;
        await release.promise;

        return {
          result: { ok: false, error: { kind: "cancelled", message: "Execution cancelled." } },
          calls: [],
        };
      },
    });

    await using agent = await connectMcp(server);
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => release.resolve());
    cleanup.defer(() => aborted.resolve());
    agent.client.onclose = () => disconnected.resolve();

    const request = rejectionOf(
      agent.client.callTool({ name: "execute", arguments: { code: "wait" } }),
    );

    await started.promise;
    const closing = server.close();
    expect(server.close()).toBe(closing);
    const observedClose = closing.then(() => events.push("closed"));

    await aborted.promise;
    await disconnected.promise;

    // Let SDK teardown settle while executor cleanup is still deliberately blocked.
    expect(
      await Promise.race([closing.then(() => "closed"), Bun.sleep(0).then(() => "pending")]),
    ).toBe("pending");
    release.resolve();
    await observedClose;
    await request;
    expect(events).toEqual(["aborted", "cleaned up", "released presentation resources", "closed"]);
  });
});
