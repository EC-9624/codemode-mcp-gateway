import { heapStats, memoryUsage } from "bun:jsc";
import { cpus, release } from "node:os";
import { Worker } from "node:worker_threads";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";

const settings = z.object({
  scenario: z
    .enum(["control", "worker", "wasm", "wasm-memory", "quickjs", "executor"])
    .default("executor"),
  runs: z.coerce.number().int().min(1).max(10_000).default(1000),
  "batch-size": z.coerce.number().int().min(1).max(1000).default(100),
  gc: z.enum(["natural", "forced"]).default("natural"),
  mode: z.enum(["source", "compiled"]).default("source"),
  "worker-exit": z.enum(["terminate", "natural"]).default("terminate"),
  child: z.boolean().default(false),
});

let args;
try {
  args = parseArgs({
    args: process.argv.slice(2),
    options: {
      scenario: { type: "string" },
      runs: { type: "string" },
      "batch-size": { type: "string" },
      gc: { type: "string" },
      mode: { type: "string" },
      "worker-exit": { type: "string" },
      child: { type: "boolean" },
    },
  });
} catch {
  console.error(
    "Usage: bun run baseline:memory --scenario <control|worker|wasm|wasm-memory|quickjs|executor> --runs <1-10000> --batch-size <1-1000> --gc <natural|forced> --mode <source|compiled> --worker-exit <terminate|natural>",
  );
  process.exit(1);
}

const parsed = settings.safeParse(args.values);
if (!parsed.success) {
  console.error("Invalid memory baseline options:", parsed.error.message);
  process.exit(1);
}

const options = parsed.data;
type Counts = {
  completed: number;
  workersStarted: number;
  workerReplies: number;
  workerExits: number;
  terminationsAwaited: number;
};
if (
  options["worker-exit"] === "natural" &&
  (options.scenario === "control" || options.scenario === "executor")
) {
  console.error("--worker-exit natural only applies to the direct worker probes.");
  process.exit(1);
}

if (!options.child) {
  // Only the fresh child's memory is measured. Export conditions also reach its workers.
  const child = Bun.spawn(
    [
      process.execPath,
      ...(options.mode === "source" ? ["--conditions=development"] : []),
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
      "--child",
    ],
    { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  );

  const watchdog = setTimeout(() => child.kill(), options.runs * 100 + 30_000);
  try {
    process.exitCode = await child.exited;
  } finally {
    clearTimeout(watchdog);
    child.kill();
  }
} else {
  await measure();
}

async function measure() {
  const counts = {
    completed: 0,
    workersStarted: 0,
    workerReplies: 0,
    workerExits: 0,
    terminationsAwaited: 0,
  };

  // The controls must not import the executor or its QuickJS dependency into the host.
  const execute = await operation(counts);
  console.log(
    JSON.stringify({
      phase: "environment",
      pid: process.pid,
      bun: Bun.version,
      revision: Bun.revision,
      platform: process.platform,
      arch: process.arch,
      osRelease: release(),
      cpu: cpus()[0]?.model,
      ...options,
      child: undefined,
      idleMs: 1000,
      gcMethod: options.gc === "forced" ? "Bun.gc(true), main thread only" : "automatic",
      executorEntry: options.scenario === "executor" ? import.meta.resolve("@cmg/codemode") : null,
    }),
  );
  await setImmediate();
  let previousRss = snapshot("before", counts).rss;

  while (counts.completed < options.runs) {
    const size = Math.min(options["batch-size"], options.runs - counts.completed);
    let totalMs = 0;
    let minMs = Infinity;
    let maxMs = 0;
    for (let index = 0; index < size; index++) {
      const start = performance.now();
      await execute();
      const duration = performance.now() - start;
      totalMs += duration;
      minMs = Math.min(minMs, duration);
      maxMs = Math.max(maxMs, duration);
      counts.completed++;
    }

    // Measurements occur after per-execution locals and promise jobs leave their turn.
    await setImmediate();
    const measured = snapshot("batch", counts);
    console.log(
      JSON.stringify({
        phase: "batch-summary",
        completed: counts.completed,
        size,
        rssDelta: measured.rss - previousRss,
        latencyMs: { min: minMs, mean: totalMs / size, max: maxMs },
      }),
    );
    previousRss = measured.rss;
  }

  await Bun.sleep(1000);
  snapshot("idle", counts);
}

function snapshot(phase: string, counts: Counts) {
  if (options.gc === "forced") Bun.gc(true);

  const processMemory = process.memoryUsage();
  const native = memoryUsage();
  const heap = heapStats();

  const workers =
    options.scenario === "control" || options.scenario === "executor"
      ? null
      : {
          started: counts.workersStarted,
          replies: counts.workerReplies,
          exits: counts.workerExits,
          terminationsAwaited: counts.terminationsAwaited,
        };

  console.log(
    JSON.stringify({
      phase,
      completed: counts.completed,
      workers,
      ...processMemory,
      native,
      heap: {
        heapSize: heap.heapSize,
        heapCapacity: heap.heapCapacity,
        extraMemorySize: heap.extraMemorySize,
        objectCount: heap.objectCount,
        protectedObjectCount: heap.protectedObjectCount,
        globalObjectCount: heap.globalObjectCount,
        objectTypeCounts: heap.objectTypeCounts,
      },
    }),
  );

  return { rss: processMemory.rss };
}

async function operation(counts: Counts): Promise<() => Promise<void>> {
  if (options.scenario === "control") return async () => {};

  if (options.scenario === "executor") {
    const { CodeExecutor } = await import("@cmg/codemode");
    const executor = new CodeExecutor();

    return async () => {
      const report = await executor.execute("return 42;");
      if (!report.result.ok || report.result.value !== 42 || report.calls.length !== 0) {
        throw new Error("Scalar execution did not return 42 with no calls.");
      }
    };
  }

  return async () => {
    const worker = new Worker(new URL("./fixtures/memory-worker.ts", import.meta.url), {
      workerData: options.scenario,
    });

    counts.workersStarted++;
    const reply = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<number>();
    const deadline = Promise.withResolvers<void>();

    const watchdog = setTimeout(
      () => deadline.reject(new Error("Diagnostic worker did not finish within 10 seconds.")),
      10_000,
    );

    let stopped = false;
    worker.once("error", (error) => reply.reject(error));
    worker.once("message", (value: unknown) => {
      if (value !== 42) {
        reply.reject(new Error("Diagnostic worker did not return 42 after cleanup."));

        return;
      }

      counts.workerReplies++;
      reply.resolve();
    });
    worker.once("exit", (code) => {
      stopped = true;
      counts.workerExits++;
      exited.resolve(code);
      reply.reject(new Error("Diagnostic worker exited before replying."));
    });
    try {
      await Promise.race([
        deadline.promise,
        reply.promise.then(async () => {
          if (options["worker-exit"] === "natural") {
            worker.postMessage("close");
            const code = await exited.promise;
            if (code !== 0) throw new Error(`Diagnostic worker exited with code ${code}.`);
          }
        }),
      ]);
    } finally {
      clearTimeout(watchdog);
      if (!stopped) {
        await worker.terminate();
        counts.terminationsAwaited++;
      }

      await exited.promise;
      worker.removeAllListeners();
    }
  };
}
