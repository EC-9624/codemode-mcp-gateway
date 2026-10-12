import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  createDiscoveryTools,
  defineTool,
  CodemodeSandbox,
  ToolCatalog,
  ToolResult,
} from "../../src/codemode";

describe("validated native tools", () => {
  test("rejects invalid input before implementation, retains the failure, and lets the guest recover", async () => {
    const received: unknown[] = [];

    const catalog = ToolCatalog.create({
      read: defineTool({
        description: "Read a record",
        inputSchema: z.object({ id: z.number({ error: "Expected a number." }).int().min(1) }),
        execute: (args) => {
          received.push(args);

          return ToolResult.success(args);
        },
      }),
    });

    const report = await new CodemodeSandbox({ tools: catalog.tools }).execute(
      `
      let message;
      try { await tools.read({ id: "1" }); } catch (error) { message = error.message; }
      return { message, value: await tools.read({ id: 1 }) };
    `,
    );

    expect(received).toEqual([{ id: 1 }]);
    expect(report.result).toEqual({
      ok: true,
      value: { message: "Invalid arguments: /id: Expected a number.", value: { id: 1 } },
    });
    expect(report.calls).toEqual([
      {
        callId: 1,
        name: "read",
        status: "completed",
        result: { ok: false, error: { message: "Invalid arguments: /id: Expected a number." } },
      },
      { callId: 2, name: "read", status: "completed", result: { ok: true, json: '{"id":1}' } },
    ]);
  });

  test("charges local validation failures against the execution call budget", async () => {
    let calls = 0;

    const catalog = ToolCatalog.create({
      read: defineTool({
        description: "Read a number",
        inputSchema: z.number({ error: "Expected a number." }),
        execute: () => {
          calls++;

          return ToolResult.success();
        },
      }),
    });

    const report = await new CodemodeSandbox({ tools: catalog.tools, maxToolCalls: 1 }).execute(
      'try { await tools.read("wrong"); } catch {} return await tools.read(1);',
    );

    expect(calls).toBe(0);
    expect(report.result).toMatchObject({
      ok: false,
      error: { kind: "limit", resource: "tool-calls" },
    });
    expect(report.calls).toEqual([
      {
        callId: 1,
        name: "read",
        status: "completed",
        result: { ok: false, error: { message: "Invalid arguments: Expected a number." } },
      },
    ]);
  });

  test("leaves omitted argument semantics to the native schema", async () => {
    const received: unknown[] = [];
    let forbiddenCalls = 0;

    const catalog = ToolCatalog.create({
      plain: {
        description: "No schema",
        execute: (args) => {
          received.push(args);

          return ToolResult.success(args === undefined);
        },
      },
      unrestricted: defineTool({
        description: "Any input",
        inputSchema: z.unknown(),
        execute: (args) => {
          received.push(args);

          return ToolResult.success(args === undefined);
        },
      }),
      object: defineTool({
        description: "Object required",
        inputSchema: z.object({}, { error: "Expected an object." }),
        execute: () => ToolResult.success(),
      }),
      forbidden: defineTool({
        description: "Reject input",
        inputSchema: z.never({ error: "Input is forbidden." }),
        execute: () => {
          forbiddenCalls++;

          return ToolResult.success();
        },
      }),
    });

    const report = await new CodemodeSandbox({ tools: catalog.tools }).execute(
      `
      const plain = await tools.plain();
      const unrestricted = await tools.unrestricted();
      const failures = [];
      try { await tools.object(); } catch (error) { failures.push(error.message); }
      try { await tools.forbidden({}); } catch (error) { failures.push(error.message); }
      return { plain, unrestricted, failures };
    `,
    );

    expect(received).toEqual([undefined, undefined]);
    expect(forbiddenCalls).toBe(0);
    expect(report.result).toEqual({
      ok: true,
      value: {
        plain: true,
        unrestricted: true,
        failures: [
          "Invalid arguments: Expected an object.",
          "Invalid arguments: Input is forbidden.",
        ],
      },
    });
  });

  test("discovery describes the input while the implementation receives transformed output", async () => {
    const catalog = ToolCatalog.create({
      read: defineTool({
        description: "Parse a count",
        inputSchema: z.string().transform((value) => Number(value)),
        execute: (count) => ToolResult.success(count + 1),
      }),
    });

    const report = await new CodemodeSandbox({
      tools: { ...catalog.tools, ...createDiscoveryTools(catalog) },
    }).execute(
      `
      const description = await tools.describeTool({ name: "read" });
      return { type: description.inputSchema.type, value: await tools.read("2") };
    `,
    );

    expect(report.result).toEqual({ ok: true, value: { type: "string", value: 3 } });
  });

  test("cancellation during async validation closes the report and prevents late side effects", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => release.resolve());
    let calls = 0;

    const catalog = ToolCatalog.create({
      read: defineTool({
        description: "Validate slowly",
        inputSchema: z.string().transform(async (value) => {
          started.resolve();
          await release.promise;

          return value.length;
        }),
        execute: (length) => {
          calls++;

          return ToolResult.success(length);
        },
      }),
    });

    const controller = new AbortController();

    const sandbox = new CodemodeSandbox({ tools: catalog.tools });

    const completion = sandbox.execute('return await tools.read("hello");', {
      signal: controller.signal,
    });

    await started.promise;
    controller.abort();
    const report = await completion;
    release.resolve();
    await Bun.sleep(0);

    expect(calls).toBe(0);
    expect(report.result).toMatchObject({ ok: false, error: { kind: "cancelled" } });
    expect(report.calls).toEqual([
      { callId: 1, name: "read", status: "interrupted", reason: "cancelled" },
    ]);
    expect((await sandbox.execute('return await tools.read("ok");')).result).toEqual({
      ok: true,
      value: 2,
    });
    expect(calls).toBe(1);
    expect(report.calls).toEqual([
      { callId: 1, name: "read", status: "interrupted", reason: "cancelled" },
    ]);
  });
});
