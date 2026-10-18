import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";

test("opt-in OTLP exports only protobuf metrics/traces and shares trace IDs with local logs", async () => {
  await using receiver = collector();

  const result = await run({
    OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url + "collector",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "otlp",
    GW_LOG_LEVEL: "info",
  });

  const execution = result.stderr
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line))
    .map((record) =>
      z
        .object({
          eventName: z.string(),
          traceId: z.string().optional(),
          spanId: z.string().optional(),
        })
        .parse(record),
    )
    .find((record) => record.eventName === "gw.execution.finished");

  const context = z.object({ traceId: z.string(), spanId: z.string() }).parse(execution);
  const traces = receiver.requests.find((request) => request.path === "/collector/v1/traces");

  expect(result.code).toBe(0);
  expect(result.stdout).toBe("");
  expect(receiver.requests.map((request) => request.path).sort()).toEqual([
    "/collector/v1/metrics",
    "/collector/v1/traces",
  ]);
  expect(receiver.requests.map((request) => request.contentType)).toEqual([
    "application/x-protobuf",
    "application/x-protobuf",
  ]);
  expect(traces?.bytes.includes(Buffer.from(context.traceId, "hex"))).toBe(true);
  expect(traces?.bytes.includes(Buffer.from(context.spanId, "hex"))).toBe(true);
  expect(
    Buffer.concat(receiver.requests.map((request) => request.bytes)).includes(
      "private-code-and-result",
    ),
  ).toBe(false);
});

test("signal endpoints are used as-is and signal authentication overrides the general header", async () => {
  await using receiver = collector();

  const result = await run({
    OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url + "base",
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: receiver.url + "custom",
    OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20general-secret",
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: "authorization=Bearer%20trace-secret",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "otlp",
  });

  expect(result.code).toBe(0);
  expect(receiver.requests.find((request) => request.path === "/custom")?.authorization).toBe(
    "Bearer trace-secret",
  );
  expect(
    receiver.requests.find((request) => request.path === "/base/v1/metrics")?.authorization,
  ).toBe("Bearer general-secret");
  expect(result.stderr).not.toContain("general-secret");
  expect(result.stderr).not.toContain("trace-secret");
});

test.each([
  { name: "no exporter configuration", environment: {} },
  {
    name: "SDK disabled",
    environment: {
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_SDK_DISABLED: "true",
    },
  },
])("$name generates no telemetry requests", async ({ environment }) => {
  const result = await run(environment);

  expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
});

test.each([
  {
    name: "protocol",
    environment: { OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" },
    message: "supports only OTLP http/protobuf",
  },
  {
    name: "URL credentials",
    environment: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://user:private-password@127.0.0.1:4318" },
    message: "without URL credentials",
  },
  {
    name: "headers",
    environment: { OTEL_EXPORTER_OTLP_HEADERS: "authorization=private-secret%XX" },
    message: "valid percent-encoded values",
  },
  {
    name: "timeout",
    environment: { OTEL_EXPORTER_OTLP_TIMEOUT: "9999" },
    message: "between 1 and 2000",
  },
])(
  "invalid $name fails before export without echoing configuration",
  async ({ environment, message }) => {
    await using receiver = collector();

    const result = await run({
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url,
      ...environment,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stderr).not.toContain("private-");
    expect(receiver.requests).toEqual([]);
  },
);

test("collector rejection is a controlled diagnostic and cannot fail the execution or block shutdown", async () => {
  await using receiver = collector(400);

  const result = await run({
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url,
    GW_LOG_LEVEL: "info",
  });

  expect(result.code).toBe(0);
  expect(result.stderr).toContain('"gw.execution.outcome":"success"');
  expect(result.stderr).toContain('"eventName":"gw.telemetry.failed"');
  expect(result.stderr).not.toContain("private-collector-response");
  expect(receiver.requests.length).toBe(2);
});

test("an unreachable collector respects export deadlines while the process exits normally", async () => {
  const receiver = collector();
  const url = receiver.url;
  await receiver[Symbol.asyncDispose]();

  const result = await run({
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_ENDPOINT: url,
    OTEL_EXPORTER_OTLP_TIMEOUT: "100",
    GW_LOG_LEVEL: "info",
  });

  expect(result.code).toBe(0);
  expect(result.stderr).toContain('"gw.execution.outcome":"success"');
  expect(result.stderr).toContain('"eventName":"gw.telemetry.failed"');
});

test("a silent collector cannot hold the process beyond the configured export budget", async () => {
  const release = Promise.withResolvers<void>();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      await release.promise;

      return new Response();
    },
  });

  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(async () => {
    release.resolve();
    await server.stop(true);
  });

  const result = await run({
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_ENDPOINT: server.url.href,
    OTEL_EXPORTER_OTLP_TIMEOUT: "100",
    GW_LOG_LEVEL: "info",
  });

  expect(result.code).toBe(0);
  expect(result.stderr).toContain('"gw.execution.outcome":"success"');
  expect(result.stderr).toContain('"eventName":"gw.telemetry.failed"');
});

function collector(status = 200) {
  const requests: {
    path: string;
    contentType: string | null;
    authorization: string | null;
    bytes: Buffer;
  }[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        contentType: request.headers.get("content-type"),
        authorization: request.headers.get("authorization"),
        bytes: Buffer.from(await request.arrayBuffer()),
      });

      return new Response(status === 200 ? new Uint8Array() : "private-collector-response", {
        status,
        headers: { "content-type": "application/x-protobuf" },
      });
    },
  });

  return { url: server.url.href, requests, [Symbol.asyncDispose]: () => server.stop(true) };
}

async function run(environment: NodeJS.ProcessEnv) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=development",
      fileURLToPath(new URL("./fixtures/telemetry.ts", import.meta.url)),
    ],
    {
      env: { PATH: process.env.PATH, GW_LOG_LEVEL: "error", ...environment },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const watchdog = setTimeout(() => child.kill("SIGKILL"), 7000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    return { code, stdout, stderr };
  } finally {
    clearTimeout(watchdog);
  }
}
