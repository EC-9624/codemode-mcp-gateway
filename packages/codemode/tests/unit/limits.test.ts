import { describe, expect, test } from "bun:test";
import { CodemodeSandbox, type SandboxOptions } from "@cmg/codemode";
import { isPositiveInt } from "../../src/runtime/limits.js";

describe("positive integer limits", () => {
  test.each([
    ["missing", undefined],
    ["null", null],
    ["string", "1"],
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", NaN],
    ["infinite", Infinity],
    ["overflowing", 2147483648],
  ] as const)("rejects %s", (_name, value) => {
    expect(isPositiveInt(value)).toBe(false);
  });

  test("accepts the default range endpoints", () => {
    expect(isPositiveInt(1)).toBe(true);
    expect(isPositiveInt(2147483647)).toBe(true);
  });

  test("honors a smaller supplied maximum", () => {
    expect(isPositiveInt(4194304, 4194304)).toBe(true);
    expect(isPositiveInt(4194305, 4194304)).toBe(false);
  });
});

describe("constructor limit wiring", () => {
  test.each([
    ["timeoutMs", 2147483647],
    ["totalTimeoutMs", 2147483647],
    ["memoryLimitBytes", 2147483647],
    ["maxStackSizeBytes", 4194304],
    ["maxSourceBytes", 2147483647],
    ["maxOutputBytes", 2147483647],
    ["maxToolCalls", 2147483647],
    ["maxConcurrentToolCalls", 2147483647],
  ] as const)("validates %s against its range before reading tools", (name, maximum) => {
    expect(() => new CodemodeSandbox({ [name]: 1 })).not.toThrow();
    expect(() => new CodemodeSandbox({ [name]: maximum })).not.toThrow();
    let reads = 0;

    const options: SandboxOptions = {
      [name]: maximum + 1,
      get tools() {
        reads++;

        return {};
      },
    };

    expect(() => new CodemodeSandbox(options)).toThrow(
      new RangeError(`${name} must be an integer from 1 to ${maximum}.`),
    );
    expect(reads).toBe(0);
  });

  test.each(["maxToolCalls", "totalTimeoutMs"] as const)(
    "does not default an explicitly null %s",
    (name) => {
      const options: SandboxOptions = {};
      Object.assign(options, { [name]: null });

      expect(() => new CodemodeSandbox(options)).toThrow(RangeError);
    },
  );
});
