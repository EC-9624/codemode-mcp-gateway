import { describe, expect, test } from "bun:test";
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { Configuration, Gateway, GatewayHttpServer } from "codemode-mcp-gateway";
import { responseText, responseValue } from "./support/output.ts";
import { rejectionOf } from "./support/rejection.ts";
import { z } from "zod";

const token = "synthetic-local-service-token-0123456789012345";

describe("shared HTTP gateway", () => {
  test.each([
    { name: "short", token: "short" },
    { name: "oversized", token: "x".repeat(257) },
    { name: "invalid characters", token: "synthetic-private-token-containing a-space" },
  ])("rejects a $name bearer token before opening a listener", async ({ token }) => {
    await using gateway = new Gateway(
      Configuration.parse({
        mcp: { servers: { notes: { type: "local", command: ["unused"], disabled: true } } },
      }),
      process.cwd(),
    );

    const opened = await GatewayHttpServer.listen(gateway, { port: 0, bearerToken: token });

    expect(opened).toEqual({
      ok: false,
      error: {
        kind: "invalid-options",
        message:
          "Invalid HTTP options: use a valid port and a private bearer token of 32–256 letters, digits, underscores, or hyphens.",
      },
    });
  });

  test("cancels one client's execution while the other client remains usable", async () => {
    const started = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const upstream = new McpServer({ name: "shared-http-wait", version: "1" });
    upstream.registerTool("wait", { inputSchema: z.object({}) }, async (_args, { mcpReq }) => {
      const abort = () => stopped.resolve();
      mcpReq.signal.addEventListener("abort", abort, { once: true });
      if (mcpReq.signal.aborted) abort();

      started.resolve();
      try {
        await stopped.promise;

        return { content: [] };
      } finally {
        mcpReq.signal.removeEventListener("abort", abort);
      }
    });

    const wire = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });

    await upstream.connect(wire);

    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: (request) => wire.handleRequest(request),
    });

    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      stopped.resolve();
      await upstream.close();
      await listener.stop(true);
    });

    const gateway = cleanup.use(
      new Gateway(
        Configuration.parse({
          mcp: { servers: { notes: { type: "remote", url: listener.url.href } } },
        }),
        process.cwd(),
      ),
    );

    const opened = await GatewayHttpServer.listen(gateway, { port: 0, bearerToken: token });
    if (!opened.ok) throw new Error(opened.error.message);

    cleanup.use(opened.server);
    await gateway.start();
    await using a = await agent(opened.server.url);
    await using b = await agent(opened.server.url);
    const controller = new AbortController();

    const pending = rejectionOf(
      a.client.callTool(
        { name: "execute", arguments: { code: 'return await tools["notes.wait"]({});' } },
        { signal: controller.signal },
      ),
    );

    await started.promise;
    expect(responseValue(await b.call("return 44;"))).toBe(44);
    controller.abort(new Error("Synthetic caller cancellation"));
    expect((await pending).reason).toMatchObject({ code: "REQUEST_TIMEOUT" });
    await stopped.promise;
    expect(responseValue(await b.call("return 45;"))).toBe(45);
  }, 10_000);

  test.each([
    { name: "missing bearer", headers: {}, status: 401 },
    { name: "incorrect bearer", headers: { authorization: "Bearer incorrect" }, status: 401 },
    { name: "bare token", headers: { authorization: token }, status: 401 },
    {
      name: "browser origin",
      headers: { authorization: `Bearer ${token}`, origin: "https://untrusted.example" },
      status: 403,
    },
    {
      name: "forged host",
      headers: { authorization: `Bearer ${token}`, host: "untrusted.example" },
      status: 403,
    },
  ])("rejects $name before allocating sessions", async ({ headers, status }) => {
    await using app = await open();

    const response = await fetch(new URL("/mcp", app.host.url), { method: "POST", headers });

    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain(token);
    expect((await app.status()).sessions).toBe(0);
  });

  test("allows liveness without exposing authenticated status", async () => {
    await using app = await open();

    const health = await fetch(new URL("/health", app.host.url));
    const status = await fetch(new URL("/status", app.host.url));

    expect(await health.text()).toBe("ok");
    expect(status.status).toBe(401);
  });

  test("accepts the case-insensitive HTTP bearer authentication scheme", async () => {
    await using app = await open();

    const response = await fetch(new URL("/status", app.host.url), {
      headers: { authorization: `bearer ${token}` },
    });

    expect(response.status).toBe(200);
  });

  test("keeps the second client and daemon usable after deleting the first session", async () => {
    await using app = await open();
    await using a = await agent(app.host.url);
    await using b = await agent(app.host.url);

    expect(a.transport.sessionId).not.toBe(b.transport.sessionId);
    expect((await a.client.listTools()).tools.map((tool) => tool.name)).toEqual(["execute"]);
    expect(responseValue(await a.call("return 42;"))).toBe(42);
    await a.transport.terminateSession();

    expect((await app.status()).sessions).toBe(1);
    expect(responseValue(await b.call("return 43;"))).toBe(43);
  });

  test("deleting one session removes only that session's saved output", async () => {
    await using app = await open();
    await using a = await agent(app.host.url);
    await using b = await agent(app.host.url);
    const pathA = spillPath(responseText(await a.call('return "a".repeat(50_000);')));
    const pathB = spillPath(responseText(await b.call('return "b".repeat(50_000);')));

    const description = (await a.client.listTools()).tools.find(
      (tool) => tool.name === "execute",
    )?.description;

    expect(await Bun.file(pathA).text()).toBe("a".repeat(50_000));
    await a.transport.terminateSession();

    expect(await Bun.file(pathA).exists()).toBe(false);
    expect(await Bun.file(pathB).text()).toBe("b".repeat(50_000));
    expect(description).toContain("removed when it closes or retires");
    expect(description).toContain("before gateway shutdown");
    await b.transport.terminateSession();
    expect(await Bun.file(pathB).exists()).toBe(false);
  });

  test("closing the HTTP host leaves its borrowed gateway usable", async () => {
    await using app = await open();
    await app.host.close();
    const client = new Client({ name: "borrowed-gateway", version: "1" });
    const server = app.gateway.createServer();
    const [local, remote] = InMemoryTransport.createLinkedPair();
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => server.close());
    cleanup.defer(() => client.close());
    await server.connect(remote);
    await client.connect(local);

    expect(
      responseValue(await client.callTool({ name: "execute", arguments: { code: "return 44;" } })),
    ).toBe(44);
  });

  test("returns method-not-found for an optional pre-initialize probe without allocating a session", async () => {
    await using app = await open();

    const response = await fetch(app.host.url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "server/discover" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32601, message: "Method not found" },
    });
    expect((await app.status()).sessions).toBe(0);
  });

  test("reports an occupied port without disturbing the owning listener", async () => {
    await using app = await open();

    const opened = await GatewayHttpServer.listen(app.gateway, {
      port: Number(app.host.url.port),
      bearerToken: token,
    });

    expect(opened.ok).toBe(false);
    expect(opened).toMatchObject({ error: { kind: "address-in-use" } });
    expect((await fetch(new URL("/health", app.host.url))).status).toBe(200);
  });

  test("retires an abandoned session after its event stream has disconnected", async () => {
    await using app = await open(50);
    await using a = await agent(app.host.url);
    // Expiry itself is the contract: a live event stream must outlast the grace.
    await Bun.sleep(120);
    expect((await app.status()).sessions).toBe(1);

    await a.client.close();
    const deadline = performance.now() + 2_000;
    while ((await app.status()).sessions !== 0 && performance.now() < deadline) await Bun.sleep(10);

    expect((await app.status()).sessions).toBe(0);
  });
});

async function open(orphanGraceMs = 60_000) {
  const gateway = new Gateway(
    Configuration.parse({
      mcp: { servers: { absent: { type: "local", command: ["unused"], disabled: true } } },
    }),
    process.cwd(),
  );

  const opened = await GatewayHttpServer.listen(gateway, {
    port: 0,
    bearerToken: token,
    orphanGraceMs,
  });

  if (!opened.ok) {
    await gateway.close();
    throw new Error(opened.error.message);
  }

  await gateway.start();

  return {
    gateway,
    host: opened.server,
    async status() {
      const response = await fetch(new URL("/status", opened.server.url), {
        headers: { authorization: `Bearer ${token}` },
      });

      const value: unknown = await response.json();
      if (
        typeof value !== "object" ||
        value === null ||
        !("sessions" in value) ||
        typeof value.sessions !== "number"
      )
        throw new Error("Invalid daemon status");

      return { sessions: value.sessions };
    },
    async [Symbol.asyncDispose]() {
      await opened.server.close();
      await gateway.close();
    },
  };
}

async function agent(url: URL) {
  const client = new Client({ name: "native-http-test", version: "1" });

  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });

  await client.connect(transport);

  return {
    client,
    transport,
    call: (code: string) => client.callTool({ name: "execute", arguments: { code } }),
    async [Symbol.asyncDispose]() {
      await client.close();
    },
  };
}

function spillPath(text: string) {
  const path = text.match(/\[Full output: (.+)\]/)?.[1];
  if (path === undefined) throw new Error("Missing output file");

  return path;
}
