import { CodeExecutor, SandboxLimits, ToolResult } from "@codemode-mcp-gateway/codemode";

const runs = Number(process.argv[2] ?? 20);
if (process.argv.length > 3 || !Number.isInteger(runs) || runs < 2 || runs > 200) {
  console.error("Usage: bun run baseline [runs-per-scenario: 2-200]");
  process.exit(1);
}

console.log(
  JSON.stringify({
    step: "environment",
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    runs,
    limits: Object.fromEntries(
      Object.entries(SandboxLimits).map(([name, limit]) => [
        name,
        "default" in limit ? limit.default : null,
      ]),
    ),
    rssSampleIntervalMs: 5,
  }),
);

for (const scenario of [
  { name: "scalar", payloadBytes: 0 },
  { name: "tool-1KiB", payloadBytes: 1024 },
  { name: "tool-1MiB", payloadBytes: 1024 * 1024 },
]) {
  const payload = { text: "x".repeat(Math.max(0, scenario.payloadBytes - 11)) };

  const toolResponseBytes =
    scenario.payloadBytes === 0 ? 0 : Buffer.byteLength(JSON.stringify(payload), "utf8");

  const sandbox = new CodeExecutor({ tools: { read: () => ToolResult.success(payload) } });

  const code =
    scenario.payloadBytes === 0 ? "return 42;" : "return (await tools.read()).text.length;";

  const expectedValue = scenario.payloadBytes === 0 ? 42 : payload.text.length;
  const rssBefore = process.memoryUsage.rss();
  let sampledPeakRss = rssBefore;

  const sample = () => {
    sampledPeakRss = Math.max(sampledPeakRss, process.memoryUsage.rss());
  };

  const timer = setInterval(sample, 5);
  using cleanup = new DisposableStack();
  cleanup.defer(() => clearInterval(timer));
  const durations: number[] = [];
  const rssAfterExecutions: number[] = [];

  for (let iteration = 1; iteration <= runs; iteration++) {
    const started = performance.now();
    const report = await sandbox.execute(code);
    const elapsedMs = performance.now() - started;
    if (
      !report.result.ok ||
      report.result.value !== expectedValue ||
      report.calls.length !== (scenario.payloadBytes === 0 ? 0 : 1) ||
      report.calls.some((call) => call.status !== "completed" || Object.hasOwn(call, "result")) ||
      toolResponseBytes !== scenario.payloadBytes
    ) {
      console.error(
        JSON.stringify({
          scenario: scenario.name,
          iteration,
          status: "failed",
          message: "Execution did not match the baseline workload.",
        }),
      );
      process.exitCode = 1;
      break;
    }

    sample();
    durations.push(elapsedMs);
    const rss = process.memoryUsage.rss();
    rssAfterExecutions.push(rss);
    console.log(
      JSON.stringify({ scenario: scenario.name, iteration, elapsedMs, toolResponseBytes, rss }),
    );
  }

  if (process.exitCode === 1) break;

  const subsequent = durations.slice(1).sort((a, b) => a - b);
  const middle = Math.floor(subsequent.length / 2);
  const upper = subsequent[middle];
  const lower = subsequent[middle - 1] ?? upper;
  if (upper === undefined || lower === undefined)
    throw new Error("Expected subsequent execution samples.");

  console.log(
    JSON.stringify({
      scenario: scenario.name,
      status: "passed",
      runs,
      firstMs: durations[0],
      subsequentMs: {
        min: subsequent[0],
        median: subsequent.length % 2 === 0 ? (lower + upper) / 2 : upper,
        max: subsequent.at(-1),
      },
      rss: {
        before: rssBefore,
        after: process.memoryUsage.rss(),
        sampledPeak: sampledPeakRss,
        afterExecutions: rssAfterExecutions,
      },
    }),
  );
}
