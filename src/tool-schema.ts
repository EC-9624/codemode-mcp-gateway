import { type StandardSchemaV1 } from "@standard-schema/spec";
import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020";
import { fullFormats } from "ajv-formats/dist/formats";

/** JSON Schema metadata. Absent $schema means draft 2020-12. */
export type ToolSchema = boolean | Readonly<Record<string, unknown>>;

/** Each compiled schema owns its engine, so tool-local $id/$ref names cannot collide. */
export function compileToolSchema(schema: ToolSchema) {
  let snapshot: ToolSchema;
  try {
    snapshot = structuredClone(schema);
  } catch (cause) {
    return { ok: false, message: "Input schema could not be copied.", cause } as const;
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
    return {
      ok: false,
      message: "Input schema must use JSON Schema 2020-12 or draft-07.",
      cause: undefined,
    } as const;
  }

  const options = {
    strict: false,
    strictNumbers: true,
    validateSchema: true,
    allErrors: false,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    ownProperties: true,
    addUsedSchema: false,
    logger: false,
  } as const;

  const engine = draft7
    ? // Draft-07 ignores $ref siblings; 2020-12 evaluates them.
      new Ajv({ ...options, ignoreKeywordsWithRef: true })
    : new Ajv2020(options);

  for (const [name, format] of Object.entries(fullFormats)) engine.addFormat(name, format);

  let compiled: ValidateFunction<unknown>;
  try {
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

    compiled = engine.compile<unknown>(input);
  } catch (cause) {
    return {
      ok: false,
      message: "Input schema is invalid or has unresolved references.",
      cause,
    } as const;
  }

  // Ajv's synchronous overload can still return an async function for runtime-authored schemas.
  if ("$async" in compiled && compiled.$async === true) {
    return {
      ok: false,
      message: "Asynchronous input schemas are not supported.",
      cause: undefined,
    } as const;
  }

  const check = compiled;

  const validator = {
    "~standard": {
      version: 1,
      vendor: "mcm",
      validate(value: unknown): StandardSchemaV1.Result<unknown> {
        if (check(value)) return { value };

        const error = check.errors?.[0];

        return {
          issues: [
            {
              message: `${error?.instancePath || "/"} ${error?.message ?? "does not match the input schema"}.`,
            },
          ],
        };
      },
    },
  } satisfies StandardSchemaV1;

  return { ok: true, schema: snapshot, validator } as const;
}
