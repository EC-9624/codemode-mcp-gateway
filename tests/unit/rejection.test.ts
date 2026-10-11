import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { rejectionOf } from "../support/rejection";

test("rejectionOf preserves arbitrary rejection reasons and their identity", async () => {
  for (const reason of [
    new Error("failure"),
    { message: "failure" },
    "failure",
    undefined,
    null,
    0,
  ]) {
    expect((await rejectionOf(Promise.reject(reason))).reason).toBe(reason);
  }
});

test("rejectionOf preserves fulfilled and pending promises without awaiting them", async () => {
  for (const reason of [Promise.resolve(42), new Promise(() => {})]) {
    expect((await rejectionOf(Promise.reject(reason))).reason).toBe(reason);
  }
});

test("rejectionOf fails on fulfillment, including resolved Error values", async () => {
  for (const value of [undefined, 42, new Error("resolved value")]) {
    await rejects(rejectionOf(Promise.resolve(value)), {
      message: "Expected the operation to reject, but it resolved.",
    });
  }
});
