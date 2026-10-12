import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { rejectionOf } from "../support/rejection";

test("rejectionOf preserves the original rejection reason by identity", async () => {
  const reason = { message: "failure" };

  expect((await rejectionOf(Promise.reject(reason))).reason).toBe(reason);
});

test("rejectionOf preserves a pending promise reason without awaiting it", async () => {
  const reason = new Promise(() => {});

  expect((await rejectionOf(Promise.reject(reason))).reason).toBe(reason);
});

test("rejectionOf rejects fulfillment even when the resolved value is an Error", async () => {
  await rejects(rejectionOf(Promise.resolve(new Error("resolved value"))), {
    message: "Expected the operation to reject, but it resolved.",
  });
});
