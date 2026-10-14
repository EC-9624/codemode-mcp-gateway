import { describe, expect, test } from "bun:test";
import { authorize } from "../../src/auth/oauth.ts";
import { memoryCredentials, oauthFixture } from "../support/oauth.ts";
import { rejectionOf } from "../support/rejection.ts";

describe("OAuth authorization attempt", () => {
  test.each([
    { name: "duplicate code", parameters: "code=synthetic-code&code=other-code" },
    { name: "empty code", parameters: "code=" },
    { name: "missing result", parameters: "" },
    { name: "code and error", parameters: "code=synthetic-code&error=access_denied" },
    { name: "empty error", parameters: "error=" },
    { name: "duplicate issuer", parameters: "code=synthetic-code&iss=https://other.example" },
  ])("rejects $name in the OAuth layer before exchanging tokens", async ({ parameters }) => {
    await using upstream = await oauthFixture();

    const memory = memoryCredentials();

    const prepared = await authorize(
      { id: "test", url: upstream.url },
      memory.store,
      AbortSignal.timeout(5_000),
    );

    if (!prepared.ok) throw new Error(prepared.error.message);

    await using attempt = prepared.value;

    const callback = await upstream.authorize(attempt.url);
    callback.searchParams.delete("code");
    for (const [name, value] of new URLSearchParams(parameters)) {
      callback.searchParams.append(name, value);
    }

    // The listener acknowledges delivery; only the OAuth layer interprets the response.
    expect((await fetch(callback)).status).toBe(200);
    expect(await attempt.complete()).toMatchObject({ ok: false, error: { kind: "invalid" } });
    expect(upstream.exchanges).toBe(0);
    expect(memory.record?.authorization).toEqual({ status: "required" });
  });

  test("shares one code exchange and leaves completed-grant persistence to its caller", async () => {
    await using upstream = await oauthFixture();

    const memory = memoryCredentials();

    const prepared = await authorize(
      { id: "test", url: upstream.url },
      memory.store,
      AbortSignal.timeout(5_000),
    );

    if (!prepared.ok) throw new Error(prepared.error.message);

    await using attempt = prepared.value;

    const first = attempt.complete();
    const second = attempt.complete();
    await fetch(await upstream.authorize(attempt.url));

    expect(await first).toMatchObject({
      ok: true,
      value: { authorization: { status: "authorized", tokens: { access_token: "access-1" } } },
    });
    expect(await second).toEqual(await first);
    expect(upstream.exchanges).toBe(1);
    expect(memory.record?.authorization).toEqual({ status: "required" });
  });

  test("an expired callback cannot exchange a code and is closed on disposal", async () => {
    await using upstream = await oauthFixture();

    const memory = memoryCredentials();

    const prepared = await authorize(
      { id: "test", url: upstream.url },
      memory.store,
      AbortSignal.timeout(100),
    );

    if (!prepared.ok) throw new Error(prepared.error.message);

    await using attempt = prepared.value;

    const callback = await upstream.authorize(attempt.url);
    expect(await attempt.complete()).toMatchObject({ ok: false, error: { kind: "cancelled" } });
    expect((await fetch(callback)).status).toBe(400);
    expect(upstream.exchanges).toBe(0);
    await attempt[Symbol.asyncDispose]();
    expect((await rejectionOf(fetch(callback))).reason).toBeInstanceOf(TypeError);
  });
});
