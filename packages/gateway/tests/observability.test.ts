import { expect, spyOn, test } from "bun:test";
import { Configuration, Gateway, Logger, type GatewayLog } from "codemode-mcp-gateway";
import { z } from "zod";
import { promises } from "node:fs";
import { fileURLToPath } from "node:url";
import { connect } from "./support/gateway.ts";
import { oauthFixture } from "./support/oauth.ts";

const configuration = Configuration.parse({
  mcp: { servers: { paused: { type: "local", command: ["unused"], disabled: true } } },
});

test("execution logs contain service identity and metadata without submitted or returned content", async () => {
  const records: GatewayLog[] = [];

  const logger = new Logger({
    version: "test-version",
    instanceId: "test-instance",
    onLog: (record) => records.push(record),
  });

  await using gateway = new Gateway(configuration, ".", { logger });
  await gateway.start();
  await using agent = await connect(gateway.createServer());

  const response = await agent.client.callTool({
    name: "execute",
    arguments: { code: 'return "private-result-content";' },
  });

  const record = records.find((record) => record.eventName === "gw.execution.finished");

  expect(response.content).toEqual([{ type: "text", text: "private-result-content" }]);
  expect(record).toMatchObject({
    severityNumber: 9,
    severityText: "INFO",
    eventName: "gw.execution.finished",
    body: "Execution finished.",
    resource: {
      "service.name": "codemode-mcp-gateway",
      "service.version": "test-version",
      "service.instance.id": "test-instance",
    },
    instrumentationScope: { name: "codemode-mcp-gateway", version: "test-version" },
    attributes: {
      "gw.transport": "embedded",
      "gw.execution.outcome": "success",
      "gw.execution.calls.total": 0,
      "gw.execution.calls.completed": 0,
      "gw.execution.calls.interrupted": 0,
    },
  });
  expect(record?.timestamp).toMatch(/^\d{4}-\d\d-\d\dT/u);
  expect(executionIdentity(record)["gw.session.id"]).toMatch(/^[a-f0-9-]{36}$/u);
  expect(executionIdentity(record)["gw.execution.id"]).toMatch(/^[a-f0-9-]{36}$/u);
  expect(
    z.object({ "gw.execution.duration_ms": z.number() }).parse(record?.attributes)[
      "gw.execution.duration_ms"
    ],
  ).toBeGreaterThanOrEqual(0);
  expect(record).not.toHaveProperty("traceId");
  expect(record).not.toHaveProperty("spanId");
  expect(JSON.stringify(records)).not.toContain("private-result-content");
});

test("concurrent tool exceptions retain their own session and execution correlation", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  await using upstream = await oauthFixture({
    mcp: async (request) => {
      if (request.method !== "POST") return;

      const body = z
        .object({
          method: z.string(),
          id: z.union([z.string(), z.number()]).optional(),
          params: z.unknown().optional(),
        })
        .parse(await request.clone().json());

      if (body.method !== "tools/call") return;

      if (
        z.object({ arguments: z.object({ a: z.number() }) }).parse(body.params).arguments.a === 1
      ) {
        started.resolve();
        await release.promise;
      }

      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32603, message: "private-upstream-message" },
      });
    },
  });

  using cleanup = new DisposableStack();
  cleanup.defer(() => release.resolve());
  const records: GatewayLog[] = [];
  const logger = new Logger({ level: "debug", onLog: (record) => records.push(record) });

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
    { logger },
  );

  await gateway.start();
  await using slow = await connect(gateway.createServer());
  await using fast = await connect(gateway.createServer());

  const pending = slow.client.callTool({
    name: "execute",
    arguments: { code: 'return await tools["notes.add"]({a:1,b:1});' },
  });

  await started.promise;
  await fast.client.callTool({
    name: "execute",
    arguments: { code: 'return await tools["notes.add"]({a:2,b:2});' },
  });
  release.resolve();
  await pending;
  const failures = records.filter((record) => record.eventName === "gw.tool.exception");
  const executions = records.filter((record) => record.eventName === "gw.execution.finished");

  expect(failures).toHaveLength(2);
  expect(failures[0]).toMatchObject({
    attributes: { "gw.tool.name": "notes.add", "gw.tool.call_id": 1, "error.type": "mcp_protocol" },
  });
  expect(failures[1]).toMatchObject({
    attributes: { "gw.tool.name": "notes.add", "gw.tool.call_id": 1 },
  });
  expect(executionIdentity(failures[0])).toEqual(executionIdentity(executions[0]));
  expect(executionIdentity(failures[1])).toEqual(executionIdentity(executions[1]));
  expect(executionIdentity(failures[0])).not.toEqual(executionIdentity(failures[1]));
  expect(JSON.stringify(records)).not.toContain("private-upstream-message");
  expect(JSON.stringify(records)).not.toContain("access-0");
});

test.each([
  { name: "script", code: 'throw new Error("private-script-message");', outcome: "script_error" },
  { name: "timeout", code: "while (true) {}", outcome: "timeout" },
  {
    name: "tool-call limit",
    code: 'await tools.searchTools({query:"notes"}); await tools.searchTools({query:"notes"});',
    outcome: "limit",
  },
])(
  "execution logs distinguish $name outcomes without recording guest messages",
  async ({ code, outcome }) => {
    const records: GatewayLog[] = [];
    const logger = new Logger({ onLog: (record) => records.push(record) });

    await using gateway = new Gateway(
      Configuration.parse({ ...configuration, sandbox: { timeoutMs: 100, maxToolCalls: 1 } }),
      ".",
      { logger },
    );

    await gateway.start();
    await using agent = await connect(gateway.createServer());

    await agent.client.callTool({ name: "execute", arguments: { code } });

    expect(records.find((record) => record.eventName === "gw.execution.finished")).toMatchObject({
      severityText: "WARN",
      attributes: { "gw.execution.outcome": outcome },
    });
    expect(JSON.stringify(records)).not.toContain("private-script-message");
  },
);

test("session lifecycle logs share a local diagnostic ID and include the close reason", async () => {
  const records: GatewayLog[] = [];
  const logger = new Logger({ level: "debug", onLog: (record) => records.push(record) });
  await using gateway = new Gateway(configuration, ".", { logger });

  const agent = await connect(
    gateway.createServer({ transport: "http", closeReason: () => "idle" }),
  );

  await agent[Symbol.asyncDispose]();

  expect(records[0]).toMatchObject({
    eventName: "gw.session.opened",
    attributes: { "gw.transport": "http" },
  });
  expect(records[1]).toMatchObject({
    eventName: "gw.session.closed",
    attributes: { "gw.session.close_reason": "idle" },
  });
  expect(
    z.object({ "gw.session.id": z.string() }).parse(records[0]?.attributes)["gw.session.id"],
  ).toMatch(/^[a-f0-9-]{36}$/u);
  expect(records[1]?.attributes).toMatchObject(records[0]?.attributes ?? {});
});

test("log level filters both local records and callback sinks", () => {
  const records: GatewayLog[] = [];
  const logger = new Logger({ level: "warn", onLog: (record) => records.push(record) });

  logger.emit({
    name: "gw.service.started",
    attributes: { "gw.transport": "http", "process.pid": 1 },
  });
  logger.emit({
    name: "gw.service.failed",
    attributes: { "gw.component": "http", "error.type": "infrastructure" },
  });

  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    eventName: "gw.service.failed",
    severityNumber: 17,
    severityText: "ERROR",
  });
});

test("a failing log sink does not change execution results and reports its failure once", async () => {
  using diagnostics = spyOn(console, "error").mockImplementation(() => {});

  const logger = new Logger({
    onLog: () => {
      throw new Error("private-log-sink-detail");
    },
  });

  await using gateway = new Gateway(configuration, ".", { logger });
  await gateway.start();
  await using agent = await connect(gateway.createServer());

  const response = await agent.client.callTool({
    name: "execute",
    arguments: { code: "return 42;" },
  });

  expect(response.content).toEqual([{ type: "text", text: "42" }]);
  expect(diagnostics).toHaveBeenCalledTimes(1);
  expect(diagnostics.mock.calls[0]?.[0]).toContain('"eventName":"gw.logging.failed"');
  expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("private-log-sink-detail");
});

test("output-save failures use a dedicated event and preserve a caller's diagnostic callback", async () => {
  const records: GatewayLog[] = [];
  const logger = new Logger({ onLog: (record) => records.push(record) });
  await using gateway = new Gateway(configuration, ".", { logger });
  const server = gateway.createServer();
  const failures: Error[] = [];
  server.server.onerror = (error) => failures.push(error);
  await using agent = await connect(server);

  using fault = spyOn(promises, "mkdtemp").mockRejectedValue(
    new Error("private-filesystem-detail"),
  );

  const response = await agent.client.callTool({
    name: "execute",
    arguments: { code: 'return "x".repeat(50_000);' },
  });

  expect(response.isError).toBeUndefined();
  expect(fault).toHaveBeenCalledTimes(1);
  expect(failures).toHaveLength(1);
  expect(records.filter((record) => record.eventName === "gw.output.save_failed")).toHaveLength(1);
  expect(records.filter((record) => record.eventName === "gw.protocol.failed")).toHaveLength(0);
  expect(JSON.stringify(records)).not.toContain("private-filesystem-detail");
});

test("redirected logs use complete JSON records and do not enable export from OTEL environment variables", async () => {
  const requests: string[] = [];

  const receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(request.url);

      return new Response();
    },
  });

  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => receiver.stop(true));

  const result = await loggerProcess("pipe", { OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url.href });
  const record: unknown = JSON.parse(result.stderr);

  expect(result.code).toBe(0);
  expect(result.stdout).toBe("");
  expect(record).toMatchObject({
    eventName: "gw.upstream.state_changed",
    severityNumber: 9,
    attributes: { "gw.upstream.name": "notes\n\u001b[31mred\u001b[0m", "gw.upstream.tools": 2 },
  });
  expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
  expect(requests).toEqual([]);
});

test("terminal logs render the same metadata on one readable line without terminal escapes", async () => {
  const result = await loggerProcess("terminal");

  expect(result.code).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("INFO  Upstream state changed.");
  expect(result.stderr).toContain("upstream=notes red state=connected tools=2");
  expect(result.stderr).not.toContain("\u001b");
  expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
});

test("a recovering diagnostic stream reports whole-record drops before resuming output", async () => {
  const result = await loggerProcess("backpressure");

  expect(result.code).toBe(0);
  expect(result.stderr).toContain('"eventName":"gw.logging.failed"');
  expect(result.stderr).toContain('"gw.logging.failure":"backpressure","gw.logging.dropped":1');
  expect(result.stderr).toContain('"eventName":"gw.upstream.state_changed"');
  expect(result.stderr).not.toContain('"eventName":"gw.service.started"');
  expect(result.stderr.trimEnd().split("\n")).toHaveLength(2);
});

test("an invalid logging level fails with controlled guidance without echoing its value", async () => {
  const result = await loggerProcess("pipe", { GW_LOG_LEVEL: "private-invalid-level" });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("GW_LOG_LEVEL must be debug, info, warn, or error.");
  expect(result.stderr).not.toContain("private-invalid-level");
});

function executionIdentity(record: GatewayLog | undefined) {
  return z
    .object({ "gw.session.id": z.string(), "gw.execution.id": z.string() })
    .parse(record?.attributes);
}

async function loggerProcess(mode: string, environment: NodeJS.ProcessEnv = {}) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=development",
      fileURLToPath(new URL("./fixtures/logging.ts", import.meta.url)),
      mode,
    ],
    {
      env: { ...process.env, GW_LOG_LEVEL: "info", ...environment },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { code, stdout, stderr };
}
