import { describe, expect, test } from "bun:test";
import { compileToolSchema, type ToolSchema } from "../../src/tool-schema";

describe("tool schema compilation", () => {
  test.each([
    ["negative length", { type: "string", minLength: -1 }],
    ["duplicate required property", { type: "object", required: ["x", "x"] }],
    ["invalid regex", { type: "string", pattern: "[" }],
    ["external reference", { $ref: "https://example.invalid/schema" }],
    ["unsupported dialect", { $schema: "https://json-schema.org/draft/2019-09/schema" }],
    ["invalid dialect type", { $schema: 42 }],
    ["asynchronous schema", { $async: true, type: "number" }],
  ] satisfies [string, ToolSchema][])("rejects %s at compilation", (_name, schema) => {
    const result = compileToolSchema(schema);

    expect(result.ok).toBe(false);
  });

  test("reports cloning failure without losing its cause", () => {
    const result = compileToolSchema({ type: "object", extension: () => {} });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected schema compilation failure");

    expect(result.cause).toBeInstanceOf(Error);
    expect(result.message).toBe("Input schema could not be copied.");
  });

  test("uses 2020-12 tuple keywords by default", () => {
    const schema = compile({ type: "array", prefixItems: [{ type: "number" }], items: false });

    expect(schema.validator["~standard"].validate([1])).toEqual({ value: [1] });
    expect(schema.validator["~standard"].validate(["1"]).issues).toBeDefined();
    expect(schema.validator["~standard"].validate([1, 2]).issues).toBeDefined();
  });

  test("uses draft-07 tuple keywords when explicitly declared", () => {
    const schema = compile({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "array",
      items: [{ type: "number" }],
      additionalItems: false,
    });

    expect(schema.validator["~standard"].validate([1])).toEqual({ value: [1] });
    expect(schema.validator["~standard"].validate([1, 2]).issues).toBeDefined();
  });

  test.each([
    "http://json-schema.org/draft/2020-12/schema#",
    "https://json-schema.org/draft/2020-12/schema#",
    "https://json-schema.org/draft-07/schema#",
    "http://json-schema.org/draft-07/schema",
  ])("accepts dialect URI alias %s without rewriting discovery metadata", ($schema) => {
    const schema = compile({ $schema, type: "number" });

    expect(schema.schema).toEqual({ $schema, type: "number" });
    expect(schema.validator["~standard"].validate("1").issues).toBeDefined();
    expect(schema.validator["~standard"].validate(1)).toEqual({ value: 1 });
  });

  test.each([true, false])(
    "handles boolean schema %s including omitted native arguments",
    (value) => {
      const schema = compile(value);

      expect(schema.validator["~standard"].validate(undefined)).toEqual(
        value ? { value: undefined } : { issues: [{ message: "/ boolean schema is false." }] },
      );
    },
  );

  test("validates nested required fields and compositions", () => {
    const schema = compile({
      type: "object",
      properties: {
        query: {
          anyOf: [
            { type: "string", minLength: 1 },
            { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
          ],
        },
      },
      required: ["query"],
    });

    expect(schema.validator["~standard"].validate({ query: "text" }).issues).toBeUndefined();
    expect(schema.validator["~standard"].validate({ query: { id: 1 } }).issues).toBeUndefined();
    expect(schema.validator["~standard"].validate({ query: {} }).issues).toBeDefined();
    expect(schema.validator["~standard"].validate({}).issues).toBeDefined();
  });

  test("validates known formats and permits unknown format annotations", () => {
    const known = compile({ type: "string", format: "email" });
    const unknown = compile({ type: "string", format: "product-id" });

    expect(known.validator["~standard"].validate("user@example.com").issues).toBeUndefined();
    expect(known.validator["~standard"].validate("invalid").issues).toBeDefined();
    expect(unknown.validator["~standard"].validate("product-1")).toEqual({ value: "product-1" });
  });

  test("does not coerce, insert defaults, remove extra properties, or replace input", () => {
    const schema = compile({
      type: "object",
      properties: { count: { type: "number" }, optional: { type: "number", default: 3 } },
      additionalProperties: false,
    });

    const invalid = { count: "2", extra: true };
    const valid = { count: 2 };

    expect(schema.validator["~standard"].validate(invalid).issues).toBeDefined();
    expect(invalid).toEqual({ count: "2", extra: true });
    const accepted = schema.validator["~standard"].validate(valid);
    if (accepted.issues) throw new Error("Expected valid arguments");

    expect(accepted.value).toBe(valid);
    expect(valid).toEqual({ count: 2 });
  });

  test("requires own properties rather than accepting inherited JSON object methods", () => {
    const schema = compile({ type: "object", required: ["toString"] });

    expect(schema.validator["~standard"].validate({}).issues).toBeDefined();
    expect(schema.validator["~standard"].validate({ toString: "present" }).issues).toBeUndefined();
  });

  test("isolates root and nested identifiers while preserving local references", () => {
    const numeric = compile({
      $id: "https://example.invalid/input",
      $defs: { value: { $id: "value", type: "number" } },
      type: "object",
      properties: { value: { $ref: "value" } },
    });

    const text = compile({
      $id: "https://example.invalid/input",
      $defs: { value: { $id: "value", type: "string" } },
      type: "object",
      properties: { value: { $ref: "value" } },
    });

    expect(numeric.validator["~standard"].validate({ value: 1 }).issues).toBeUndefined();
    expect(text.validator["~standard"].validate({ value: 1 }).issues).toBeDefined();
    expect(text.validator["~standard"].validate({ value: "one" }).issues).toBeUndefined();
  });

  test("supports local definitions and recursive references", () => {
    const schema = compile({
      $defs: {
        node: {
          type: "object",
          properties: { next: { $ref: "#/$defs/node" }, value: { type: "number" } },
          required: ["value"],
        },
      },
      $ref: "#/$defs/node",
    });

    expect(
      schema.validator["~standard"].validate({ value: 1, next: { value: 2 } }).issues,
    ).toBeUndefined();
    expect(schema.validator["~standard"].validate({ value: 1, next: { value: "2" } })).toEqual({
      issues: [{ message: "/next/value must be number." }],
    });
  });

  test("resolves local named anchors", () => {
    const schema = compile({
      $defs: { count: { $anchor: "count", type: "integer" } },
      type: "object",
      properties: { count: { $ref: "#count" } },
    });

    expect(schema.validator["~standard"].validate({ count: 1 }).issues).toBeUndefined();
    expect(schema.validator["~standard"].validate({ count: "1" }).issues).toBeDefined();
  });

  test.each([
    ["draft-07", "http://json-schema.org/draft-07/schema#", true],
    ["2020-12", "https://json-schema.org/draft/2020-12/schema", false],
  ] as const)("applies %s semantics to keywords beside a reference", (_name, $schema, accepted) => {
    const schema = compile({
      $schema,
      definitions: { number: { type: "number" } },
      $ref: "#/definitions/number",
      maximum: 0,
    });

    expect(schema.validator["~standard"].validate(1).issues === undefined).toBe(accepted);
  });

  test("snapshots the schema rather than retaining mutable caller metadata", () => {
    const input = { type: "string", enum: ["before"] };
    const schema = compile(input);
    input.enum[0] = "after";

    expect(schema.schema).toEqual({ type: "string", enum: ["before"] });
    expect(schema.validator["~standard"].validate("before").issues).toBeUndefined();
    expect(schema.validator["~standard"].validate("after").issues).toBeDefined();
  });
});

function compile(schema: ToolSchema) {
  const result = compileToolSchema(schema);
  if (!result.ok) throw new Error(result.message, { cause: result.cause });

  return result;
}
