import { spawn } from "node:child_process";
// Historical runtime study; current executor code does not support the Node host.
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";

const args = parseArgs({
  options: {
    directory: { type: "string" },
    node: { type: "string", default: "node" },
    bun: { type: "string", default: "bun" },
    candidate: { type: "string" },
    smoke: { type: "boolean", default: false },
  },
});

const options = z
  .object({
    directory: z.string().min(1),
    node: z.string(),
    bun: z.string(),
    candidate: z.string().optional(),
    smoke: z.boolean(),
  })
  .parse(args.values);

const directory = resolve(options.directory);
await mkdir(directory, { recursive: true });
const runner = fileURLToPath(new URL("./runtime-comparison.ts", import.meta.url));
const contract = fileURLToPath(new URL("./runtime-contract.ts", import.meta.url));

const hosts = [
  { name: "bun-default", executable: options.bun, fastMemory: undefined },
  { name: "bun-no-fast-memory", executable: options.bun, fastMemory: "false" },
  ...(options.candidate === undefined
    ? []
    : [{ name: "bun-candidate", executable: options.candidate, fastMemory: undefined }]),
  { name: "node", executable: options.node, fastMemory: undefined },
];

const results: unknown[] = [];

const scenarios = [
  { scenario: "empty", runs: 3000, concurrency: 1, repeats: 1 },
  { scenario: "wasm", runs: 3000, concurrency: 1, repeats: 2 },
  { scenario: "scalar", runs: 3000, concurrency: 1, repeats: 3 },
  { scenario: "tool", runs: 200, concurrency: 1, repeats: 3 },
  { scenario: "tool", runs: 200, concurrency: 4, repeats: 3 },
  { scenario: "cpu", runs: 200, concurrency: 1, repeats: 3 },
  { scenario: "microtasks", runs: 100, concurrency: 1, repeats: 3 },
  { scenario: "mcp", runs: 200, concurrency: 1, repeats: 3 },
  { scenario: "mcp", runs: 200, concurrency: 4, repeats: 3 },
];

for (const host of hosts) await run(host, [contract], `${host.name}-contract`, 30000);

for (const workload of scenarios) {
  const repeats = options.smoke ? 1 : workload.repeats;
  const runs = options.smoke ? 8 : workload.runs;
  for (let repetition = 0; repetition < repeats; repetition++) {
    // Rotate order between repetitions to reduce a fixed warm-cache/thermal ordering bias.
    const ordered = [
      ...hosts.slice(repetition % hosts.length),
      ...hosts.slice(0, repetition % hosts.length),
    ];

    for (const host of ordered) {
      const label = `${host.name}-${workload.scenario}-c${workload.concurrency}-r${repetition + 1}`;
      await run(
        host,
        [
          runner,
          "--scenario",
          workload.scenario,
          "--runs",
          String(runs),
          "--batch",
          String(Math.min(100, runs)),
          "--concurrency",
          String(workload.concurrency),
        ],
        label,
        Math.max(60000, runs * 200),
      );

      const records = (await readFile(join(directory, label + ".jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line): unknown => JSON.parse(line));

      const result = { label, records };
      results.push(result);
      await writeFile(join(directory, "results.json"), JSON.stringify(results, null, 2) + "\n");
    }
  }
}

async function run(
  host: (typeof hosts)[number],
  parameters: string[],
  label: string,
  timeoutMs: number,
) {
  await using output = await open(join(directory, label + ".jsonl"), "wx");
  await using errors = await open(join(directory, label + ".stderr"), "wx");
  const environment = { ...process.env };
  delete environment.NODE_OPTIONS;
  delete environment.BUN_JSC_useWasmFastMemory;
  if (host.fastMemory !== undefined) environment.BUN_JSC_useWasmFastMemory = host.fastMemory;

  const started = performance.now();

  const child = spawn(host.executable, parameters, {
    env: environment,
    stdio: ["ignore", output.fd, errors.fd],
  });

  let forced = false;

  const timer = setTimeout(() => {
    forced = true;
    child.kill("SIGKILL");
  }, timeoutMs);

  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (done, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => done({ code, signal }));
      },
    );

    if (forced || exit.code !== 0 || exit.signal !== null)
      throw new Error(
        `${label} failed: ${JSON.stringify({ ...exit, forced })}. Inspect ${label}.stderr.`,
      );

    console.log(JSON.stringify({ label, elapsedMs: performance.now() - started, ...exit, forced }));
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}
