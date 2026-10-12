import { type StandardSchemaV1 } from "@standard-schema/spec";
import { Ajv, type Options, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020";
import { fullFormats } from "ajv-formats/dist/formats";
import { type ToolSchema } from "../codemode";

/** A synchronous Standard Schema: compilation rejects asynchronous JSON Schemas. */
export type ToolSchemaValidator = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    validate(value: unknown): StandardSchemaV1.Result<unknown>;
  };
};

export type CompiledToolSchema =
  | { ok: true; schema: ToolSchema; validator: ToolSchemaValidator }
  | { ok: false; message: string; cause?: unknown };

const OPTIONS = {
  strict: false,
  strictNumbers: true,
  allErrors: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  ownProperties: true,
  addUsedSchema: false,
  logger: false,
} as const satisfies Options;

// Draft-07 ignores $ref siblings; 2020-12 evaluates them.
const DRAFT7_OPTIONS = { ...OPTIONS, ignoreKeywordsWithRef: true } as const satisfies Options;

// Compiling a meta-schema validator costs milliseconds per engine. These shared engines only
// check schemas as data and never register them, so tool-local identifiers stay isolated.
const META = {
  draft7: new Ajv({ ...DRAFT7_OPTIONS, validateSchema: true }),
  draft2020: new Ajv2020({ ...OPTIONS, validateSchema: true }),
};

/** Each compiled schema owns its engine, so tool-local $id/$ref names cannot collide. */
export function compileToolSchema(schema: ToolSchema): CompiledToolSchema {
  let snapshot: ToolSchema;
  try {
    snapshot = structuredClone(schema);
  } catch (cause) {
    return { ok: false, message: "Input schema could not be copied.", cause };
  }

  const declared = typeof snapshot === "boolean" ? undefined : snapshot.$schema;
  const dialect = typeof declared === "string" ? declared.replace(/#$/, "") : declared;

  const draft7 =
    dialect === "http://json-schema.org/draft-07/schema" ||
    dialect === "https://json-schema.org/draft-07/schema";

  if (
    dialect !== undefined &&
    dialect !== "https://json-schema.org/draft/2020-12/schema" &&
    dialect !== "http://json-schema.org/draft/2020-12/schema" &&
    !draft7
  ) {
    return { ok: false, message: "Input schema must use JSON Schema 2020-12 or draft-07." };
  }

  const engine = draft7
    ? new Ajv({ ...DRAFT7_OPTIONS, validateSchema: false })
    : new Ajv2020({ ...OPTIONS, validateSchema: false });

  for (const [name, format] of Object.entries(fullFormats)) engine.addFormat(name, format);

  // Ajv registers canonical meta-schema URIs; aliases describe the same dialect.
  const input =
    typeof snapshot === "boolean" || declared === undefined
      ? snapshot
      : {
          ...snapshot,
          $schema: draft7
            ? "http://json-schema.org/draft-07/schema#"
            : "https://json-schema.org/draft/2020-12/schema",
        };

  const meta = draft7 ? META.draft7 : META.draft2020;
  let check: ValidateFunction<unknown>;
  try {
    // Matches the error Ajv's own compile-time schema validation would throw.
    if (meta.validateSchema(input) !== true) {
      throw new Error(`schema is invalid: ${meta.errorsText()}`);
    }

    check = engine.compile<unknown>(input);
  } catch (cause) {
    return { ok: false, message: "Input schema is invalid or has unresolved references.", cause };
  }

  // Ajv's synchronous overload can still return an async function for runtime-authored schemas.
  if ("$async" in check && check.$async === true) {
    return { ok: false, message: "Asynchronous input schemas are not supported." };
  }

  const validator = {
    "~standard": {
      version: 1,
      vendor: "mcm",
      validate(value: unknown): StandardSchemaV1.Result<unknown> {
        if (check(value)) return { value };

        const error = check.errors?.[0];
        const message = error?.message ?? "does not match the input schema";

        return { issues: [{ message: `${error?.instancePath || "/"} ${message}.` }] };
      },
    },
  } satisfies StandardSchemaV1;

  return { ok: true, schema: snapshot, validator };
}
