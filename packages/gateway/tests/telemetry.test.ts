import { expect, test } from "bun:test";
import { AlwaysOffSampler, InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { Configuration, Gateway, Logger, Telemetry, type GatewayLog } from "codemode-mcp-gateway";
import { z } from "zod";
import { connect, within } from "./support/gateway.ts";
import { oauthFixture } from "./support/oauth.ts";
import { Metrics, metric } from "./support/telemetry.ts";
import { rejectionOf } from "./support/rejection.ts";

const configuration = Configuration.parse({
  mcp: { servers: { paused: { type: "local", command: ["unused"], disabled: true } } },
});

test("execution metrics distinguish admitted outcomes from source rejection independently of log level", async () => {
  const records: GatewayLog[] = [];
  const logger = new Logger({ level: "error", onLog: (record) => records.push(record) });
  const metrics = new Metrics();
  await using telemetry = new Telemetry({ logger, metrics: { kind: "reader", reader: metrics } });

  await using gateway = new Gateway(
    Configuration.parse({ ...configuration, sandbox: { maxSourceBytes: 100 } }),
    ".",
    { logger, telemetry },
  );

  await gateway.start();
  await using agent = await connect(gateway.createServer());

  await agent.client.callTool({ name: "execute", arguments: { code: "return 42;" } });
  await agent.client.callTool({ name: "execute", arguments: { code: "x".repeat(101) } });
  const snapshot = await metrics.snapshot();

  expect(metric(snapshot, "gw.execution.count").dataPoints).toMatchObject([
    {
      attributes: { "gw.execution.admission": "admitted", "gw.execution.outcome": "success" },
      value: 1,
    },
    {
      attributes: {
        "gw.execution.admission": "rejected",
        "gw.execution.outcome": "limit",
        "gw.execution.limit.resource": "source",
      },
      value: 1,
    },
  ]);
  expect(metric(snapshot, "gw.execution.duration").descriptor.unit).toBe("s");
  expect(metric(snapshot, "gw.execution.active").dataPoints).toMatchObject([{ value: 0 }]);
  expect(records).toEqual([]);
  expect(JSON.stringify(snapshot.scopeMetrics)).not.toContain("gw.session.id");
  expect(JSON.stringify(snapshot.scopeMetrics)).not.toContain("gw.execution.id");
});

test("upstream spans are children of their execution and logs share the real OTel trace context", async () => {
  await using upstream = await oauthFixture();
  const records: GatewayLog[] = [];
  const logger = new Logger({ onLog: (record) => records.push(record) });
  const spans = new InMemorySpanExporter();
  const metrics = new Metrics();

  await using telemetry = new Telemetry({
    logger,
    spanExporter: spans,
    metrics: { kind: "reader", reader: metrics },
  });

  await using gateway = new Gateway(remoteConfiguration(upstream.url), ".", { logger, telemetry });
  await gateway.start();
  await using agent = await connect(gateway.createServer());

  await agent.client.callTool({
    name: "execute",
    arguments: { code: 'return await tools["notes.add"]({a:20,b:22});' },
  });
  await telemetry.flush();
  const finished = spans.getFinishedSpans();
  const execution = finished.find((span) => span.name === "gw.execution");
  const call = finished.find((span) => span.name === "gw.upstream.call");
  const record = records.find((record) => record.eventName === "gw.execution.finished");

  expect(call?.parentSpanContext?.spanId).toBe(execution?.spanContext().spanId);
  expect(call?.spanContext().traceId).toBe(execution?.spanContext().traceId);
  expect(call?.attributes).toMatchObject({
    "gw.upstream.name": "notes",
    "gw.upstream.transport": "http",
    "gw.tool.name": "notes.add",
    "gw.tool.call_id": 1,
    "gw.upstream.call.outcome": "response",
  });
  expect(record?.traceId).toBe(execution?.spanContext().traceId);
  expect(record?.spanId).toBe(execution?.spanContext().spanId);
  expect(JSON.stringify(finished.map((span) => span.attributes))).not.toContain("return await");
  expect(JSON.stringify(finished.map((span) => span.attributes))).not.toContain("access-0");
});

test.each([
  {
    name: "MCP error flag",
    result: { content: [{ type: "text", text: "private-result" }], isError: true },
    outcome: "mcp_tool_error",
    failed: false,
  },
  {
    name: "failure-shaped content",
    result: {
      content: [{ type: "text", text: '{"ok":false,"error":"private-result"}' }],
      structuredContent: { sum: 0 },
    },
    outcome: "response",
    failed: false,
  },
  {
    name: "protocol validation error",
    result: {
      content: [{ type: "text", text: "private-result" }],
      structuredContent: { private: "private-result" },
    },
    outcome: "protocol_error",
    failed: true,
  },
])(
  "upstream metrics classify $name at the MCP boundary without guessing from JSON",
  async ({ result, outcome, failed }) => {
    await using upstream = await oauthFixture({
      mcp: async (request) => {
        if (request.method !== "POST") return;

        const body = z
          .object({ method: z.string(), id: z.union([z.string(), z.number()]).optional() })
          .parse(await request.clone().json());

        if (body.method === "tools/call")
          return Response.json({ jsonrpc: "2.0", id: body.id, result });
      },
    });

    const metrics = new Metrics();
    const spans = new InMemorySpanExporter();

    await using telemetry = new Telemetry({
      spanExporter: spans,
      metrics: { kind: "reader", reader: metrics },
    });

    await using gateway = new Gateway(remoteConfiguration(upstream.url), ".", { telemetry });
    await gateway.start();
    await using agent = await connect(gateway.createServer());

    const response = await agent.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools["notes.add"]({a:1,b:1});' },
    });

    const snapshot = await metrics.snapshot();
    await telemetry.flush();

    expect(response.isError === true).toBe(failed);
    expect(metric(snapshot, "gw.upstream.call.count").dataPoints).toMatchObject([
      {
        attributes: { "gw.upstream.call.outcome": outcome, "gw.upstream.name": "notes" },
        value: 1,
      },
    ]);
    expect(
      spans.getFinishedSpans().find((span) => span.name === "gw.upstream.call")?.attributes[
        "gw.upstream.call.outcome"
      ],
    ).toBe(outcome);
    expect(JSON.stringify(snapshot.scopeMetrics)).not.toContain("gw.tool.name");
    expect(JSON.stringify(spans.getFinishedSpans().map((span) => span.attributes))).not.toContain(
      "private-result",
    );
  },
);

test("execution capacity is measured from its owner while excess submissions are rejected", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await using upstream = await blockedUpstream(started, release);
  using cleanup = new DisposableStack();
  cleanup.defer(() => release.resolve());
  const metrics = new Metrics();
  await using telemetry = new Telemetry({ metrics: { kind: "reader", reader: metrics } });

  await using gateway = new Gateway(
    Configuration.parse({
      ...remoteConfiguration(upstream.url),
      sandbox: { maxConcurrentExecutions: 1 },
    }),
    ".",
    { telemetry },
  );

  await gateway.start();
  await using agent = await connect(gateway.createServer());

  const pending = agent.client.callTool({
    name: "execute",
    arguments: { code: 'return await tools["notes.add"]({a:1,b:1});' },
  });

  await within(started.promise);

  const rejected = await agent.client.callTool({
    name: "execute",
    arguments: { code: "return 42;" },
  });

  const busy = await metrics.snapshot();
  release.resolve();
  await pending;
  const idle = await metrics.snapshot();

  expect(rejected.isError).toBe(true);
  expect(metric(busy, "gw.execution.active").dataPoints).toMatchObject([{ value: 1 }]);
  expect(metric(busy, "gw.execution.count").dataPoints).toMatchObject([
    {
      attributes: {
        "gw.execution.admission": "rejected",
        "gw.execution.limit.resource": "executions",
      },
      value: 1,
    },
  ]);
  expect(metric(idle, "gw.execution.active").dataPoints).toMatchObject([{ value: 0 }]);
});

test("interrupted calls end once and late upstream completion cannot rewrite the observation", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  await using upstream = await blockedUpstream(started, release);
  using cleanup = new DisposableStack();
  cleanup.defer(() => release.resolve());

  const logger = new Logger({
    onLog: (record) => {
      if (record.eventName === "gw.execution.finished") finished.resolve();
    },
  });

  const metrics = new Metrics();
  const spans = new InMemorySpanExporter();

  await using telemetry = new Telemetry({
    logger,
    spanExporter: spans,
    metrics: { kind: "reader", reader: metrics },
  });

  await using gateway = new Gateway(remoteConfiguration(upstream.url), ".", { logger, telemetry });
  await gateway.start();
  await using agent = await connect(gateway.createServer());
  const controller = new AbortController();

  const pending = rejectionOf(
    agent.client.callTool(
      { name: "execute", arguments: { code: 'return await tools["notes.add"]({a:1,b:1});' } },
      { signal: controller.signal },
    ),
  );

  await within(started.promise);
  controller.abort();
  await pending;
  await within(finished.promise);
  release.resolve();
  const snapshot = await metrics.snapshot();
  await telemetry.flush();

  expect(metric(snapshot, "gw.upstream.call.count").dataPoints).toMatchObject([
    { attributes: { "gw.upstream.call.outcome": "interrupted" }, value: 1 },
  ]);
  expect(spans.getFinishedSpans().filter((span) => span.name === "gw.upstream.call")).toHaveLength(
    1,
  );
  expect(
    spans.getFinishedSpans().find((span) => span.name === "gw.upstream.call")?.attributes[
      "gw.upstream.call.outcome"
    ],
  ).toBe("interrupted");
});

test("connection traces are independent background operations and state gauges reflect only current state", async () => {
  await using upstream = await oauthFixture();
  const metrics = new Metrics();
  const spans = new InMemorySpanExporter();

  await using telemetry = new Telemetry({
    spanExporter: spans,
    metrics: { kind: "reader", reader: metrics },
  });

  await using gateway = new Gateway(remoteConfiguration(upstream.url), ".", { telemetry });

  await gateway.start();
  const snapshot = await metrics.snapshot();
  await telemetry.flush();
  const connection = spans.getFinishedSpans().find((span) => span.name === "gw.upstream.connect");

  const initialization = spans
    .getFinishedSpans()
    .find((span) => span.name === "gw.upstream.initialize");

  const discovery = spans.getFinishedSpans().find((span) => span.name === "gw.upstream.discovery");

  expect(connection?.parentSpanContext).toBeUndefined();
  expect(initialization?.parentSpanContext?.spanId).toBe(connection?.spanContext().spanId);
  expect(discovery?.parentSpanContext?.spanId).toBe(connection?.spanContext().spanId);
  expect(metric(snapshot, "gw.upstream.connection.count").dataPoints).toMatchObject([
    {
      attributes: {
        "gw.upstream.connection.trigger": "initial",
        "gw.upstream.connection.outcome": "connected",
      },
      value: 1,
    },
  ]);
  expect(
    metric(snapshot, "gw.upstream.state").dataPoints.find(
      (point) => point.attributes["gw.upstream.state"] === "connected",
    )?.value,
  ).toBe(1);
  expect(
    metric(snapshot, "gw.upstream.state").dataPoints.find(
      (point) => point.attributes["gw.upstream.state"] === "connecting",
    )?.value,
  ).toBe(0);
});

test("parallel executions retain distinct traces and parent their own concurrent tool calls", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await using upstream = await blockedUpstream(started, release, 2);
  using cleanup = new DisposableStack();
  cleanup.defer(() => release.resolve());
  const spans = new InMemorySpanExporter();
  await using telemetry = new Telemetry({ spanExporter: spans });
  await using gateway = new Gateway(remoteConfiguration(upstream.url), ".", { telemetry });
  await gateway.start();
  await using first = await connect(gateway.createServer());
  await using second = await connect(gateway.createServer());

  const pending = Promise.all([
    first.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools["notes.add"]({a:1,b:1});' },
    }),
    second.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools["notes.add"]({a:2,b:2});' },
    }),
  ]);

  await within(started.promise);
  release.resolve();
  await pending;
  await telemetry.flush();
  const executions = spans.getFinishedSpans().filter((span) => span.name === "gw.execution");
  const calls = spans.getFinishedSpans().filter((span) => span.name === "gw.upstream.call");

  expect(executions).toHaveLength(2);
  expect(calls).toHaveLength(2);
  expect(new Set(executions.map((span) => span.spanContext().traceId)).size).toBe(2);
  expect(
    calls
      .map((span) => span.parentSpanContext?.spanId)
      .sort((a, b) => (a ?? "").localeCompare(b ?? "")),
  ).toEqual(executions.map((span) => span.spanContext().spanId).sort());
  expect(calls.map((span) => span.attributes["gw.tool.call_id"])).toEqual([1, 1]);
});

test("failed connections report unavailable state without exporting command or exception data", async () => {
  const metrics = new Metrics();
  const spans = new InMemorySpanExporter();

  await using telemetry = new Telemetry({
    spanExporter: spans,
    metrics: { kind: "reader", reader: metrics },
  });

  await using gateway = new Gateway(
    Configuration.parse({
      mcp: { servers: { missing: { type: "local", command: ["private-command-must-not-exist"] } } },
    }),
    ".",
    { telemetry },
  );

  await gateway.start();
  const snapshot = await metrics.snapshot();
  await telemetry.flush();
  const connection = spans.getFinishedSpans().find((span) => span.name === "gw.upstream.connect");

  expect(metric(snapshot, "gw.upstream.connection.count").dataPoints).toMatchObject([
    { attributes: { "gw.upstream.connection.outcome": "failed" }, value: 1 },
  ]);
  expect(
    metric(snapshot, "gw.upstream.state").dataPoints.find(
      (point) => point.attributes["gw.upstream.state"] === "failed",
    )?.value,
  ).toBe(1);
  expect(connection?.status.code).toBe(2);
  expect(JSON.stringify(spans.getFinishedSpans().map((span) => span.attributes))).not.toContain(
    "private-command",
  );
});

test("trace sampling does not filter metrics and session counts return to zero", async () => {
  const metrics = new Metrics();
  const spans = new InMemorySpanExporter();

  await using telemetry = new Telemetry({
    spanExporter: spans,
    sampler: new AlwaysOffSampler(),
    metrics: { kind: "reader", reader: metrics },
  });

  await using gateway = new Gateway(configuration, ".", { telemetry });
  const agent = await connect(gateway.createServer());

  await agent.client.callTool({ name: "execute", arguments: { code: "return 42;" } });
  const active = await metrics.snapshot();
  await agent[Symbol.asyncDispose]();
  const closed = await metrics.snapshot();
  await telemetry.flush();

  expect(metric(active, "gw.session.active").dataPoints).toMatchObject([{ value: 1 }]);
  expect(metric(closed, "gw.session.active").dataPoints).toMatchObject([{ value: 0 }]);
  expect(metric(closed, "gw.execution.count").dataPoints).toMatchObject([{ value: 1 }]);
  expect(spans.getFinishedSpans()).toEqual([]);
});

function remoteConfiguration(url: string) {
  return Configuration.parse({
    mcp: {
      servers: { notes: { type: "remote", url, headers: { Authorization: "Bearer access-0" } } },
    },
  });
}

async function blockedUpstream(
  started: PromiseWithResolvers<void>,
  release: PromiseWithResolvers<void>,
  expectedCalls = 1,
) {
  let calls = 0;

  return oauthFixture({
    mcp: async (request) => {
      if (request.method !== "POST") return;

      const body = z.object({ method: z.string() }).parse(await request.clone().json());
      if (body.method === "tools/call") {
        if (++calls === expectedCalls) started.resolve();

        await release.promise;
      }
    },
  });
}
