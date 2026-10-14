import { describe, expect, test } from "bun:test";
import { listenForCallback } from "../../src/auth/loopback.ts";
import { rejectionOf } from "../support/rejection.ts";

describe("OAuth loopback listener", () => {
  test.each([
    { name: "wrong method", method: "POST", path: "/oauth/callback", host: undefined },
    { name: "wrong path", method: "GET", path: "/other", host: undefined },
    { name: "wrong host", method: "GET", path: "/oauth/callback", host: "example.com" },
  ])("rejects $name without consuming the callback", async ({ method, path, host }) => {
    const opened = await listenForCallback("synthetic-state", new AbortController().signal);
    if (!opened.ok) throw new Error(opened.error.message);

    await using listener = opened.value;

    const wrong = new URL(path, listener.redirectUri);
    wrong.searchParams.set("state", "synthetic-state");

    const rejected = await fetch(wrong, {
      method,
      ...(host === undefined ? {} : { headers: { Host: host } }),
    });

    expect(rejected.status).toBe(404);
    expect(rejected.headers.get("cache-control")).toBe("no-store");
    expect(rejected.headers.get("referrer-policy")).toBe("no-referrer");
    const valid = new URL(listener.redirectUri);
    valid.searchParams.set("state", "synthetic-state");
    valid.searchParams.set("code", "synthetic-code");
    expect((await fetch(valid)).status).toBe(200);
    const received = await listener.response;
    if (!received.ok) throw new Error(received.error.message);

    expect(received.value.href).toBe(valid.href);
  });

  test("disposal cancels an unanswered callback and closes the listener", async () => {
    const opened = await listenForCallback("synthetic-state", new AbortController().signal);
    if (!opened.ok) throw new Error(opened.error.message);

    await using listener = opened.value;

    await listener[Symbol.asyncDispose]();

    expect(await listener.response).toMatchObject({ ok: false, error: { kind: "cancelled" } });
    expect((await rejectionOf(fetch(listener.redirectUri))).reason).toBeInstanceOf(TypeError);
  });
});
