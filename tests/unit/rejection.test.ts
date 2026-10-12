import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { rejectionOf } from "../support/rejection";

test.each([
  ["an Error", new Error("failure")],
  ["a plain object", { message: "failure" }],
  ["a string", "failure"],
  ["undefined", undefined],
  ["null", null],
  ["zero", 0],
] as const)(
  "rejectionOf preserves %s as the rejection reason by identity",
  async (_name, reason) => {
    expect((await rejectionOf(Promise.reject(reason))).reason).toBe(reason);
  },
);

test.each([
  ["fulfilled", Promise.resolve(42)],
  ["pending", new Promise(() => {})],
] as const)(
  "rejectionOf preserves a %s promise reason without awaiting it",
  async (_name, reason) => {
    expect((await rejectionOf(Promise.reject(reason))).reason).toBe(reason);
  },
);

test.each([
  ["undefined", undefined],
  ["a number", 42],
  ["an Error value", new Error("resolved value")],
] as const)("rejectionOf fails when the operation fulfills with %s", async (_name, value) => {
  await rejects(rejectionOf(Promise.resolve(value)), {
    message: "Expected the operation to reject, but it resolved.",
  });
});
