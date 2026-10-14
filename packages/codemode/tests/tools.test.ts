import { describe, expect, expectTypeOf, test } from "bun:test";
import { z } from "zod";
import {
  CodemodeSandbox,
  createDiscoveryTools,
  defineTool,
  validateTool,
  ToolCatalog,
  ToolResult,
  type ToolInputSchema,
} from "@cmg/codemode";
import { rejectionOf } from "./support/rejection.ts";

describe("Standard Schema native tools", () => {
  test("rejects invalid input before implementation, retains the failure, and lets the guest recover", async () => {
    const received: unknown[] = [];

    const read = defineTool({
      description: "Read a record",
      inputSchema: z.object({ id: z.number({ error: "Expected a number." }).int().min(1) }),
      execute: (args) => {
        expectTypeOf(args).toEqualTypeOf<{ id: number }>();
        received.push(args);

        return ToolResult.success(args);
      },
    });

    const sandbox = new CodemodeSandbox({ tools: { read: read.execute } });

    const report = await sandbox.execute(`
      let message;
      try { await tools.read({ id: "1" }); } catch (error) { message = error.message; }
      return { message, value: await tools.read({ id: 1 }) };
    `);

    expect(received).toEqual([{ id: 1 }]);
    expect(report).toEqual({
      result: {
        ok: true,
        value: { message: "Invalid arguments: /id: Expected a number.", value: { id: 1 } },
      },
      calls: [
        {
          callId: 1,
          name: "read",
          status: "completed",
          result: { ok: false, error: { message: "Invalid arguments: /id: Expected a number." } },
        },
        { callId: 2, name: "read", status: "completed", result: { ok: true, json: '{"id":1}' } },
      ],
    });
  });

  test("charges validation failures against the execution call budget", async () => {
    let calls = 0;

    const read = defineTool({
      description: "Read a number",
      inputSchema: z.number({ error: "Expected a number." }),
      execute: () => ToolResult.success(++calls),
    });

    const report = await new CodemodeSandbox({
      tools: { read: read.execute },
      maxToolCalls: 1,
    }).execute('try { await tools.read("wrong"); } catch {} return await tools.read(1);');

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

    const accept = defineTool({
      description: "Any input",
      inputSchema: z.unknown(),
      execute: (args) => {
        received.push(args);

        return ToolResult.success(args === undefined);
      },
    });

    const object = defineTool({
      description: "Object required",
      inputSchema: z.object({}, { error: "Expected an object." }),
      execute: (args) => {
        received.push(args);

        return ToolResult.success();
      },
    });

    const report = await new CodemodeSandbox({
      tools: { accept: accept.execute, object: object.execute },
    }).execute(`
      const absent = await tools.accept();
      try { await tools.object(); } catch (error) { return { absent, message: error.message }; }
    `);

    expect(received).toEqual([undefined]);
    expect(report.result).toEqual({
      ok: true,
      value: { absent: true, message: "Invalid arguments: Expected an object." },
    });
  });

  test("discovery describes input while the handler receives asynchronously transformed output", async () => {
    const catalog = ToolCatalog.create({
      read: defineTool({
        description: "Parse a count",
        inputSchema: z.string().transform(async (value) => Number(value)),
        execute: (count) => {
          expectTypeOf(count).toEqualTypeOf<number>();

          return ToolResult.success(count + 1);
        },
      }),
    });

    const sandbox = new CodemodeSandbox({
      tools: { ...catalog.tools, ...createDiscoveryTools(catalog) },
    });

    const report = await sandbox.execute(`
      const description = await tools.describeTool({ name: "read" });
      return { type: description.inputSchema.type, value: await tools.read("2") };
    `);

    expect(report.result).toEqual({ ok: true, value: { type: "string", value: 3 } });
  });

  test("cancellation during native validation fixes the report and prevents late side effects", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const validated = Promise.withResolvers<void>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => release.resolve());
    let calls = 0;

    const read = validateTool(
      {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: async (value: unknown) => {
            started.resolve();
            await release.promise;
            validated.resolve();

            return { value };
          },
        },
      },
      (value) => {
        calls++;

        return ToolResult.success(value);
      },
    );

    const controller = new AbortController();
    const sandbox = new CodemodeSandbox({ tools: { read } });

    const completion = sandbox.execute('return await tools.read("invoice-1");', {
      signal: controller.signal,
    });

    await started.promise;
    controller.abort();
    const report = await completion;
    release.resolve();
    await validated.promise;
    expect((await sandbox.execute('return await tools.read("invoice-2");')).result).toEqual({
      ok: true,
      value: "invoice-2",
    });

    expect(calls).toBe(1);
    expect(report).toEqual({
      result: { ok: false, error: { kind: "cancelled", message: "Execution cancelled." } },
      calls: [{ callId: 1, name: "read", status: "interrupted", reason: "cancelled" }],
    });
  });

  test("accepts an independent Standard Schema implementation and exports metadata once", async () => {
    let exports = 0;
    let validations = 0;
    const metadata = { type: "number" };

    const schema: ToolInputSchema<unknown, number> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate(value) {
          validations++;

          return typeof value === "number"
            ? { value: value * 2 }
            : { issues: [{ message: "Expected a number." }] };
        },
        jsonSchema: {
          input(options) {
            expect(options.target).toBe("draft-2020-12");
            exports++;

            return metadata;
          },
          output: () => ({ type: "number" }),
        },
      },
    };

    const tool = defineTool({
      description: "Double",
      inputSchema: schema,
      execute: (value) => {
        expectTypeOf(value).toEqualTypeOf<number>();

        return ToolResult.success(value);
      },
    });

    metadata.type = "string";
    const catalog = ToolCatalog.create({ double: tool });
    const context = { signal: new AbortController().signal };

    expect(await tool.execute(2, context)).toEqual(ToolResult.success(4));
    expect(await tool.execute(3, context)).toEqual(ToolResult.success(6));
    expect(catalog.describe("double")?.inputSchema).toEqual({ type: "number" });
    expect(exports).toBe(1);
    expect(validations).toBe(2);
  });

  test("renders asynchronous validation issues with escaped standard path segments", async () => {
    let calls = 0;

    const schema: ToolInputSchema = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async () => ({
          issues: [{ message: "Invalid field.", path: [{ key: "a/b~c" }, 0] }],
        }),
        jsonSchema: { input: () => ({ type: "object" }), output: () => ({ type: "object" }) },
      },
    };

    const tool = defineTool({
      description: "Validate",
      inputSchema: schema,
      execute: () => {
        calls++;

        return ToolResult.success();
      },
    });

    expect(await tool.execute({}, { signal: new AbortController().signal })).toEqual(
      ToolResult.failure("Invalid arguments: /a~1b~0c/0: Invalid field."),
    );
    expect(calls).toBe(0);
  });

  test("keeps unexpected async validator exceptions private", async () => {
    const schema: ToolInputSchema = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async () => {
          throw new Error("Private validation details");
        },
        jsonSchema: { input: () => ({ type: "string" }), output: () => ({ type: "string" }) },
      },
    };

    const tool = defineTool({
      description: "Validate",
      inputSchema: schema,
      execute: () => ToolResult.success(),
    });

    const report = await new CodemodeSandbox({ tools: { read: tool.execute } }).execute(
      "try { await tools.read('input'); } catch (error) { return error.message; }",
    );

    expect(report).toEqual({
      result: { ok: true, value: "Host tool failed." },
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

  test("pre-aborted calls do not run the validator or the handler", async () => {
    let validations = 0;
    let calls = 0;

    const tool = defineTool({
      description: "Validate",
      inputSchema: z.string().refine(() => {
        validations++;

        return true;
      }),
      execute: () => {
        calls++;

        return ToolResult.success();
      },
    });

    // Cancellation reasons are arbitrary; a promise reason must stay opaque to the rejection oracle.
    const reason = new Promise(() => {});

    const rejected = await rejectionOf(
      Promise.resolve(tool.execute("input", { signal: AbortSignal.abort(reason) })),
    );

    expect(rejected.reason).toBe(reason);
    expect(validations).toBe(0);
    expect(calls).toBe(0);
  });

  test("cancellation during async validation prevents subsequent handler invocation", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => release.resolve());
    let calls = 0;

    const tool = validateTool(
      {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: async (value: unknown) => {
            started.resolve();
            await release.promise;

            return { value };
          },
        },
      },
      () => {
        calls++;

        return ToolResult.success();
      },
    );

    const controller = new AbortController();
    const reason = new Error("Cancelled during validation");

    const rejected = rejectionOf(Promise.resolve(tool("input", { signal: controller.signal })));

    await started.promise;
    controller.abort(reason);
    release.resolve();

    expect((await rejected).reason).toBe(reason);
    expect(calls).toBe(0);
  });

  test("keeps JSON-export failures on the host during tool definition", () => {
    const cause = new Error("JSON export unavailable");

    const schema: ToolInputSchema = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) => ({ value }),
        jsonSchema: {
          input: () => {
            throw cause;
          },
          output: () => ({}),
        },
      },
    };

    expect(() =>
      defineTool({
        description: "Export",
        inputSchema: schema,
        execute: () => ToolResult.success(),
      }),
    ).toThrow(cause);
  });
});
