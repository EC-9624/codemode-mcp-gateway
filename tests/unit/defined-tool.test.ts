import { describe, expect, expectTypeOf, test } from "bun:test";
import { z } from "zod";
import { defineTool, ToolCatalog, ToolResult, type ToolInputSchema } from "../../src/codemode";
import { callTool } from "../../src/codemode/tools";
import { rejectionOf } from "../support/rejection";

describe("Standard Schema native tools", () => {
  test("infers handler arguments and passes the transformed output", async () => {
    const tool = defineTool({
      description: "Parse a quantity",
      inputSchema: z
        .object({ quantity: z.string() })
        .transform(({ quantity }) => ({ quantity: Number(quantity) })),
      execute: (args) => {
        expectTypeOf(args).toEqualTypeOf<{ quantity: number }>();

        return ToolResult.success(args.quantity + 1);
      },
    });

    expect(await tool.execute({ quantity: "2" }, { signal: new AbortController().signal })).toEqual(
      ToolResult.success(3),
    );
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      properties: { quantity: { type: "string" } },
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

  test("awaits async validation and gives the handler its output", async () => {
    const tool = defineTool({
      description: "Count characters",
      inputSchema: z.string().transform(async (value) => value.length),
      execute: (length) => {
        expectTypeOf(length).toEqualTypeOf<number>();

        return ToolResult.success(length);
      },
    });

    expect(await tool.execute("hello", { signal: new AbortController().signal })).toEqual(
      ToolResult.success(5),
    );
  });

  test("reports issue paths without invoking the handler", async () => {
    let calls = 0;

    const tool = defineTool({
      description: "Read a record",
      inputSchema: z.object({ id: z.number({ error: "Expected a number." }) }),
      execute: () => {
        calls++;

        return ToolResult.success();
      },
    });

    expect(await tool.execute({ id: "wrong" }, { signal: new AbortController().signal })).toEqual(
      ToolResult.failure("Invalid arguments: /id: Expected a number."),
    );
    expect(calls).toBe(0);
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

    expect(await callTool(tool.execute, "input", { signal: new AbortController().signal })).toEqual(
      ToolResult.failure("Host tool failed."),
    );
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

    const reason = new Error("Cancelled");

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

    const tool = defineTool({
      description: "Validate slowly",
      inputSchema: z.string().transform(async (value) => {
        started.resolve();
        await release.promise;

        return value.length;
      }),
      execute: () => {
        calls++;

        return ToolResult.success();
      },
    });

    const controller = new AbortController();
    const reason = new Error("Cancelled during validation");

    const rejected = rejectionOf(
      Promise.resolve(tool.execute("input", { signal: controller.signal })),
    );

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
