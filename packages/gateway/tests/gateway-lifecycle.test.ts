import { describe, expect, spyOn, test } from "bun:test";
import { Configuration, Gateway } from "codemode-mcp-gateway";
import { oauthFixture } from "./support/oauth.ts";
import { rejectionOf } from "./support/rejection.ts";
import { within } from "./support/gateway.ts";

describe("gateway connection lifecycle", () => {
  test("shutdown cancels a blocked initialized notification without waiting for its response", async () => {
    const initialized = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    await using upstream = await oauthFixture({
      mcp: async (request) => {
        if (request.method !== "POST") return;

        const body: unknown = await request.clone().json();
        if (
          typeof body !== "object" ||
          body === null ||
          !("method" in body) ||
          body.method !== "notifications/initialized"
        )
          return;

        initialized.resolve();
        await release.promise;

        return new Response(null, { status: 202 });
      },
    });

    await using gateway = new Gateway(
      Configuration.parse({
        mcp: {
          servers: {
            notes: {
              type: "remote",
              url: upstream.url,
              headers: { Authorization: "Bearer access-0" },
            },
          },
        },
      }),
      ".",
    );

    using gates = new DisposableStack();
    gates.defer(() => release.resolve());

    const starting = gateway.start();
    await within(initialized.promise);
    await within(gateway.close(), 1000);
    await starting;

    expect(() => gateway.createServer()).toThrow("Gateway is closed.");
  });

  test("the startup budget includes a stalled initialized-notification response body", async () => {
    const initialized = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    await using upstream = await oauthFixture({
      mcp: async (request) => {
        if (request.method !== "POST") return;

        const body: unknown = await request.clone().json();
        if (
          typeof body !== "object" ||
          body === null ||
          !("method" in body) ||
          body.method !== "notifications/initialized"
        )
          return;

        initialized.resolve();

        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(" "));
            },
            async pull(controller) {
              await release.promise;
              controller.close();
            },
          }),
          { status: 202 },
        );
      },
    });

    await using gateway = new Gateway(
      Configuration.parse({
        mcp: {
          servers: {
            notes: {
              type: "remote",
              url: upstream.url,
              headers: { Authorization: "Bearer access-0" },
            },
          },
        },
      }),
      ".",
    );

    using gates = new DisposableStack();
    gates.defer(() => release.resolve());

    const starting = gateway.start();
    await within(initialized.promise);
    await within(starting, 6500);

    expect(gateway.status()).toMatchObject([{ state: "failed", error: { kind: "connect" } }]);
  }, 9000);

  test("successful initialization disarms the startup timer without aborting its SSE stream", async () => {
    await using upstream = await oauthFixture();
    const opened = Promise.withResolvers<AbortSignal>();
    const request = globalThis.fetch;

    using transport = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        (...args: Parameters<typeof fetch>) => {
          const [url, init] = args;
          const address = url instanceof URL ? url.href : url;
          if (address === upstream.url && init?.method === "GET" && init.signal)
            opened.resolve(init.signal);

          return request(...args);
        },
        { preconnect: request.preconnect },
      ),
    );

    await using gateway = new Gateway(
      Configuration.parse({
        mcp: {
          servers: {
            notes: {
              type: "remote",
              url: upstream.url,
              headers: { Authorization: "Bearer access-0" },
            },
          },
        },
      }),
      ".",
    );

    await gateway.start();
    const signal = await within(opened.promise);
    transport.mockRestore();
    await Bun.sleep(5100);

    expect(signal.aborted).toBe(false);
    expect(gateway.status()).toMatchObject([{ state: "connected" }]);
    await gateway.close();
    expect(signal.aborted).toBe(true);
  }, 8000);

  test("close cancels initialization queued by start without opening an upstream", async () => {
    await using upstream = await oauthFixture();

    const gateway = new Gateway(
      Configuration.parse({
        mcp: {
          servers: {
            notes: {
              type: "remote",
              url: upstream.url,
              headers: { Authorization: "Bearer access-0" },
            },
          },
        },
      }),
      ".",
    );

    const starting = gateway.start();
    const closing = gateway.close();
    await Promise.all([starting, closing]);

    expect(upstream.requests).toHaveLength(0);
    expect(gateway.close()).toBe(closing);
    expect(() => gateway.createServer()).toThrow("Gateway is closed.");
  });

  test("start remains single-flight when a status callback reenters it", async () => {
    let handshakes = 0;

    await using upstream = await oauthFixture({
      mcp: async (request) => {
        if (request.method !== "POST") return;

        const body: unknown = await request.clone().json();
        if (
          typeof body === "object" &&
          body !== null &&
          "method" in body &&
          body.method === "initialize"
        )
          handshakes++;
      },
    });

    let reentered = false;
    let nested: Promise<void> | undefined;

    await using gateway = new Gateway(
      Configuration.parse({
        mcp: {
          servers: {
            notes: {
              type: "remote",
              url: upstream.url,
              headers: { Authorization: "Bearer access-0" },
            },
          },
        },
      }),
      ".",
      {
        onStatus: (status) => {
          if (status.state !== "connecting" || reentered) return;

          reentered = true;
          nested = gateway.start();
        },
      },
    );

    const starting = gateway.start();
    await starting;
    await nested;

    expect(nested).toBe(starting);
    expect(handshakes).toBe(1);
    expect(gateway.status()).toMatchObject([{ state: "connected", toolCount: 1 }]);
  });

  test("cancelled startup preserves failed session deletion through failure and close", async () => {
    const discovering = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    await using upstream = await oauthFixture({
      mcp: async (request) => {
        if (request.method === "DELETE")
          return new Response("Private deletion failure", { status: 503 });

        if (request.method !== "POST") return;

        const body: unknown = await request.clone().json();
        if (
          typeof body === "object" &&
          body !== null &&
          "method" in body &&
          body.method === "tools/list"
        ) {
          discovering.resolve();
          await release.promise;
        }
      },
    });

    const gateway = new Gateway(
      Configuration.parse({
        mcp: {
          servers: {
            notes: {
              type: "remote",
              url: upstream.url,
              headers: { Authorization: "Bearer access-0" },
            },
          },
        },
      }),
      ".",
    );

    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      await rejectionOf(gateway.close());
    });
    using gates = new DisposableStack();
    gates.defer(() => release.resolve());

    const starting = rejectionOf(gateway.start());
    await within(discovering.promise);
    const closing = rejectionOf(gateway.close());
    const failed = await within(starting);
    const closed = await within(closing);

    expect(failed.reason).toBeInstanceOf(SuppressedError);
    expect(await within(gateway.failure)).toBe(failed.reason);
    expect(closed.reason).toBeInstanceOf(AggregateError);
    expect(closed.reason).toHaveProperty("errors.0", failed.reason);
    expect(upstream.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
  });
});
