import { describe, expect, spyOn, test } from "bun:test";
import { Worker } from "node:worker_threads";
import {
  CodemodeSandbox,
  SandboxExecutionError,
  ToolCatalog,
  ToolResult,
} from "../../src/codemode";
import { createCodemodeServer } from "../../src/mcp";
import { connectMcp } from "../support/mcp";
import { rejectionOf } from "../support/rejection";

describe("agent-facing MCP server", () => {
  test("exposes only execute with a strict code-only schema", async () => {
    const server = createCodemodeServer({ catalog: ToolCatalog.create({}) });
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
    expect(listing.tools[0]?.description).toContain("tools.searchTools");
    expect(listing.tools[0]?.description).toContain("tools.describeTool");
  });

  test.each([
    ["missing code", {}],
    ["non-string code", { code: 42 }],
    ["resource override", { code: "return 42;", timeoutMs: 60_000 }],
  ])("rejects %s before sandbox execution", async (_name, args) => {
    const server = createCodemodeServer({ catalog: ToolCatalog.create({}) });
    await using agent = await connectMcp(server);
    using execute = spyOn(CodemodeSandbox.prototype, "execute");

    const result = await agent.client.callTool({ name: "execute", arguments: args });

    expect(result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  test.each(["searchTools", "describeTool"])("rejects an upstream collision with %s", (name) => {
    const catalog = ToolCatalog.create({
      [name]: { description: "Upstream tool", execute: () => ToolResult.success() },
    });

    expect(() => createCodemodeServer({ catalog })).toThrow(
      `Upstream tool ${JSON.stringify(name)} conflicts with an MCM discovery helper.`,
    );
  });

  test("enforces fixed limits and exposes compact interrupted call metadata", async () => {
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));

    const catalog = ToolCatalog.create({
      read: { description: "Wait for data", execute: () => late.promise },
    });

    const server = createCodemodeServer({ catalog, sandbox: { maxToolCalls: 1 } });
    await using agent = await connectMcp(server);

    const response = await agent.client.callTool({
      name: "execute",
      arguments: { code: "tools.read(); tools.read();" },
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual({
      result: {
        ok: false,
        error: {
          kind: "limit",
          resource: "tool-calls",
          maximum: 1,
          message: "Execution exceeded the 1 tool-call limit.",
        },
      },
      calls: [{ callId: 1, name: "read", status: "interrupted", reason: "call-limit" }],
    });
  });

  test("keeps infrastructure details host-side while preserving the call summary", async () => {
    const server = createCodemodeServer({ catalog: ToolCatalog.create({}) });
    const diagnostics: Error[] = [];
    server.server.onerror = (error) => {
      diagnostics.push(error);
    };

    await using agent = await connectMcp(server);
    const cause = new Error("Private worker credentials");

    const failure = new SandboxExecutionError(
      [
        {
          callId: 1,
          name: "read",
          status: "completed",
          result: { ok: true, json: '"private payload"' },
        },
      ],
      cause,
    );

    using fault = spyOn(CodemodeSandbox.prototype, "execute").mockRejectedValue(failure);

    const response = await agent.client.callTool({
      name: "execute",
      arguments: { code: "return 42;" },
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual({
      result: { ok: false, error: { kind: "sandbox", message: "Sandbox execution failed." } },
      calls: [{ callId: 1, name: "read", status: "completed" }],
    });
    expect(JSON.stringify(response)).not.toContain("private payload");
    expect(JSON.stringify(response)).not.toContain("credentials");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.cause).toBe(failure);
    expect(fault).toHaveBeenCalledTimes(1);
  });

  test("preserves the controlled failure and call summary when diagnostics throw", async () => {
    const server = createCodemodeServer({ catalog: ToolCatalog.create({}) });
    server.server.onerror = () => {
      throw new Error("Private diagnostic output");
    };

    await using agent = await connectMcp(server);

    const failure = new SandboxExecutionError(
      [{ callId: 1, name: "read", status: "interrupted", reason: "sandbox-error" }],
      new Error("Private infrastructure details"),
    );

    using fault = spyOn(CodemodeSandbox.prototype, "execute").mockRejectedValue(failure);

    const response = await agent.client.callTool({
      name: "execute",
      arguments: { code: "return 42;" },
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toEqual({
      result: { ok: false, error: { kind: "sandbox", message: "Sandbox execution failed." } },
      calls: [{ callId: 1, name: "read", status: "interrupted", reason: "sandbox-error" }],
    });
    expect(JSON.stringify(response)).not.toContain("Private");
    expect(fault).toHaveBeenCalledTimes(1);
  });

  test("close cancels active tools and waits for actual worker termination", async () => {
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const terminating = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const catalog = ToolCatalog.create({
      wait: {
        description: "Wait for cancellation",
        execute: async (_args, { signal }) => {
          using listeners = new DisposableStack();
          const onAbort = () => aborted.resolve();
          signal.addEventListener("abort", onAbort, { once: true });
          listeners.defer(() => signal.removeEventListener("abort", onAbort));
          started.resolve();
          await aborted.promise;

          return ToolResult.failure("Stopped");
        },
      },
    });

    const server = createCodemodeServer({ catalog, sandbox: { timeoutMs: 5000 } });
    await using agent = await connectMcp(server);
    // Release before connection disposal too, so failed assertions cannot hold close open.
    await using gates = new AsyncDisposableStack();
    gates.defer(() => release.resolve());
    using termination = spyOn(Worker.prototype, "terminate");
    const terminate = termination.getMockImplementation();
    if (terminate === undefined) throw new Error("Expected the native terminate implementation");

    termination.mockImplementation(async function (this: Worker) {
      terminating.resolve();
      await release.promise;

      return terminate.call(this);
    });

    const request = rejectionOf(
      agent.client.callTool({
        name: "execute",
        arguments: { code: "return await tools.wait();" },
      }),
    );

    await started.promise;
    let closed = false;

    const closing = server.close().then(() => {
      closed = true;
    });

    await aborted.promise;
    await terminating.promise;

    expect(closed).toBe(false);
    release.resolve();
    await closing;
    await request;

    expect(closed).toBe(true);
    expect(termination).toHaveBeenCalledTimes(1);
  });
});
