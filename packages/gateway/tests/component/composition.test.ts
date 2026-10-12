import { describe, expect, spyOn, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { ToolCatalog, ToolResult } from "@cmg/codemode";
import { createServer } from "../../src/composition";
import { connectMcp } from "../support/mcp";
import { rejectionOf } from "../support/rejection";

describe("gateway composition", () => {
  test("describes the injected discovery helpers", async () => {
    const server = createServer(ToolCatalog.create({}));
    await using agent = await connectMcp(server);

    const listing = await agent.client.listTools();

    expect(listing.tools[0]?.description).toContain("tools.searchTools");
    expect(listing.tools[0]?.description).toContain("tools.describeTool");
  });

  test.each(["searchTools", "describeTool"])("rejects an upstream collision with %s", (name) => {
    const catalog = ToolCatalog.create({
      [name]: { description: "Upstream tool", execute: () => ToolResult.success() },
    });

    expect(() => createServer(catalog)).toThrow(
      `Upstream tool ${JSON.stringify(name)} conflicts with a CMG discovery helper.`,
    );
  });

  test("enforces fixed limits and exposes compact interrupted call metadata", async () => {
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));

    const catalog = ToolCatalog.create({
      read: { description: "Wait for data", execute: () => late.promise },
    });

    const server = createServer(catalog, { maxToolCalls: 1 });
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

    const server = createServer(catalog, { timeoutMs: 5000 });
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
