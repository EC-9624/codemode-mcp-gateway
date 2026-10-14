import { describe, expect, test } from "bun:test";
import { SandboxExecutionError, type ExecutionReport } from "@cmg/codemode";
import { createCodemodeServer } from "@cmg/mcp";
import { connectMcp } from "./support/mcp.ts";
import { rejectionOf } from "./support/rejection.ts";

describe("agent-facing MCP server", () => {
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

    expect(response.structuredContent).toEqual({
      result: { ok: true, value: "still available" },
      calls: [],
    });
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

    expect(response.structuredContent).toEqual({
      result: { ok: true, value: "application execution" },
      calls: [],
    });
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

  test("projects only public call fields from a custom executor", async () => {
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

    expect(response.isError).toBe(false);
    expect(response.structuredContent).toEqual({
      result: { ok: true, value: 42 },
      calls: [{ callId: 1, name: "read", status: "completed" }],
    });
    expect(response.content).toEqual([
      { type: "text", text: JSON.stringify(response.structuredContent) },
    ]);
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

    expect(response.isError).toBe(false);
    expect(response.structuredContent).toEqual({
      result: { ok: true, value: { isError: true } },
      calls: [],
    });
  });

  test("marks unsuccessful execution reports as errors", async () => {
    const report = {
      result: { ok: false, error: { kind: "script", message: "Script failed" } },
      calls: [],
    } satisfies ExecutionReport;

    await using agent = await connectMcp(createCodemodeServer({ execute: async () => report }));

    const response = await agent.client.callTool({ name: "execute", arguments: { code: "fail" } });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual({
      result: { ok: false, error: { kind: "script", message: "Script failed" } },
      calls: [],
    });
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
    expect(response.structuredContent).toEqual({
      result: { ok: false, error: { kind: "sandbox", message: "Sandbox execution failed." } },
      calls: [],
    });
    expect(JSON.stringify(response)).not.toContain("Private executor details");
    expect(diagnostics[0]?.cause).toBe(cause);
  });

  test("keeps infrastructure details host-side while preserving the call summary", async () => {
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
    expect(response.structuredContent).toEqual({
      result: { ok: false, error: { kind: "sandbox", message: "Sandbox execution failed." } },
      calls: [{ callId: 1, name: "read", status: "completed" }],
    });
    expect(JSON.stringify(response)).not.toContain("credentials");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.cause).toBe(failure);
    expect(executions).toBe(1);
  });

  test("preserves the controlled failure and call summary when diagnostics throw", async () => {
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
    expect(response.structuredContent).toEqual({
      result: { ok: false, error: { kind: "sandbox", message: "Sandbox execution failed." } },
      calls: [{ callId: 1, name: "read", status: "interrupted", reason: "sandbox-error" }],
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
    expect(events).toEqual(["aborted", "cleaned up", "closed"]);
  });
});
