import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { request } from "node:http";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

// Raw HTTP avoids automatic SSE reconnection obscuring Bun's idle timeout.
// The default GET resets; a pending JSON POST can warn yet still finish later.
for (const kind of ["GET", "POST"] as const) {
  await probe(kind, false);
  await probe(kind, true);
}

async function probe(kind: "GET" | "POST", configured: boolean) {
  await using cleanup = new AsyncDisposableStack();
  const release = Promise.withResolvers<void>();
  const upstream = new McpServer({ name: "http-idle-probe", version: "1" });
  let calls = 0;
  upstream.registerTool("wait", {}, async () => {
    calls++;
    await release.promise;

    return { content: [{ type: "text", text: "released once" }] };
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
    keepAliveMs: 15_000,
  });

  await upstream.connect(transport);

  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    ...(configured ? { idleTimeout: 30 } : {}),
    fetch: (request) => transport.handleRequest(request),
  });

  cleanup.defer(async () => {
    release.resolve();
    await upstream.close();
    await listener.stop(true);
  });

  const controller = new AbortController();

  const watchdog = setTimeout(
    () => controller.abort(new Error("Probe exceeded 25 seconds")),
    25_000,
  );

  cleanup.defer(() => {
    clearTimeout(watchdog);
    controller.abort();
  });

  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  });

  const initialized = await fetch(listener.url, {
    method: "POST",
    headers,
    signal: controller.signal,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "http-idle-probe", version: "1" },
      },
    }),
  });

  strictEqual(initialized.status, 200);
  await initialized.json();
  const session = initialized.headers.get("mcp-session-id");
  ok(session);
  headers.set("mcp-session-id", session);
  headers.set("mcp-protocol-version", "2025-11-25");

  const ready = await fetch(listener.url, {
    method: "POST",
    headers,
    signal: controller.signal,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  strictEqual(ready.status, 202);
  await ready.text();

  const started = performance.now();
  const timer = setTimeout(() => release.resolve(), 18_000);
  cleanup.defer(() => clearTimeout(timer));
  console.log(
    JSON.stringify({
      phase: "probe-start",
      kind,
      idleTimeout: configured ? 30 : "default",
      bun: Bun.version,
    }),
  );

  const result = await read().then(
    (value) => ({ ok: true, value }) as const,
    (cause: unknown) => ({ ok: false, cause }) as const,
  );

  strictEqual(
    controller.signal.aborted,
    false,
    "Probe reached its watchdog, not the server timeout",
  );
  strictEqual(result.ok, configured || kind === "POST", `${kind}: unexpected idle-timeout outcome`);
  if (result.ok) {
    strictEqual(result.value.status, 200);
    if (kind === "GET") strictEqual(result.value.text, ": keepalive\n\n");
    else
      deepStrictEqual(JSON.parse(result.value.text), {
        result: { content: [{ type: "text", text: "released once" }] },
        jsonrpc: "2.0",
        id: 2,
      });
  } else {
    ok(result.cause instanceof Error);
    ok("code" in result.cause);
    strictEqual(result.cause.code, "ECONNRESET");
    console.log(JSON.stringify({ phase: "disconnect", kind, message: result.cause.message }));
  }

  strictEqual(calls, kind === "POST" ? 1 : 0);

  const recovery = await fetch(listener.url, {
    method: "POST",
    headers,
    signal: controller.signal,
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }),
  });

  strictEqual(recovery.status, 200);
  deepStrictEqual(await recovery.json(), { result: {}, jsonrpc: "2.0", id: 3 });
  console.log(
    JSON.stringify({
      phase: "probe-passed",
      kind,
      configured,
      elapsedMs: Math.round(performance.now() - started),
      calls,
      sessionRecovered: true,
    }),
  );

  async function read() {
    return new Promise<{ status: number | undefined; text: string }>((resolve, reject) => {
      const pending = request(
        listener.url,
        { method: kind, headers: Object.fromEntries(headers), signal: controller.signal },
        (response) => {
          response.setEncoding("utf8");
          let text = "";
          response.on("data", (chunk: unknown) => {
            if (typeof chunk !== "string") {
              reject(new TypeError("Expected UTF-8 HTTP data"));

              return;
            }

            text += chunk;
            if (kind === "GET" && text.endsWith("\n\n")) {
              resolve({ status: response.statusCode, text });
              response.destroy();
            }
          });
          response.on("end", () => resolve({ status: response.statusCode, text }));
          response.on("error", reject);
        },
      );

      pending.on("error", reject);
      pending.end(
        kind === "POST"
          ? JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: { name: "wait", arguments: {} },
            })
          : undefined,
      );
    });
  }
}
