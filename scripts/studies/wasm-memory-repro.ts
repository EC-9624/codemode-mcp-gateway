// Standalone: copy this file anywhere and run `bun wasm-memory-repro.ts wasm 2000`.
// Historical Bun 1.4.2 allocator reproduction; see README.md here for context.
import { heapStats, memoryUsage } from "bun:jsc";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { setImmediate } from "node:timers/promises";

if (!isMainThread) {
  if (!parentPort) throw new Error("Expected a worker port.");

  if (workerData !== "wasm" && workerData !== "worker") throw new Error("Unknown workload.");

  if (workerData === "wasm") {
    const memory = new WebAssembly.Memory({ initial: 256 });
    const bytes = new Uint8Array(memory.buffer);
    bytes[0] = 42;
    if (bytes[0] !== 42) throw new Error("Memory write failed.");
  }

  parentPort.postMessage(42);
  parentPort.close();
} else {
  const scenario = process.argv[2] ?? "wasm";
  const runs = Number(process.argv[3] ?? 2000);
  if (
    (scenario !== "wasm" && scenario !== "worker") ||
    !Number.isInteger(runs) ||
    runs < 1 ||
    runs > 3000
  ) {
    throw new Error("Usage: bun wasm-memory-repro.ts <wasm|worker> <1-3000>");
  }

  let exits = 0;
  let replies = 0;

  const watchdog = setTimeout(() => {
    console.error("Reproduction exceeded five minutes.");
    process.exit(1);
  }, 300_000);

  function snapshot(phase: string) {
    Bun.gc(true);
    const heap = heapStats();
    console.log(
      JSON.stringify({
        phase,
        exits,
        replies,
        rss: process.memoryUsage.rss(),
        heapSize: heap.heapSize,
        heapCapacity: heap.heapCapacity,
        native: memoryUsage(),
      }),
    );
  }

  try {
    console.log(
      JSON.stringify({
        phase: "environment",
        bun: Bun.version,
        revision: Bun.revision,
        platform: process.platform,
        arch: process.arch,
        versions: process.versions,
        scenario,
        runs,
      }),
    );
    snapshot("before");
    for (let index = 0; index < runs; index++) {
      await runWorker();
      if ((index + 1) % 1000 === 0 || index + 1 === runs) {
        await setImmediate();
        snapshot("batch");
      }
    }

    await Bun.sleep(1000);
    snapshot("idle");
  } finally {
    clearTimeout(watchdog);
  }

  async function runWorker() {
    const worker = new Worker(new URL(import.meta.url), { workerData: scenario });
    let received = false;
    let stopped = false;
    try {
      await new Promise<void>((resolve, reject) => {
        worker.once("error", reject);
        worker.once("message", (value: unknown) => {
          if (value !== 42) {
            reject(new Error("Worker did not return 42."));

            return;
          }

          received = true;
          replies++;
        });
        worker.once("exit", (code) => {
          stopped = true;
          exits++;
          if (code !== 0 || !received) {
            reject(new Error(`Worker exited with code ${code}; received reply: ${received}.`));

            return;
          }

          resolve();
        });
      });
    } finally {
      if (!stopped) await worker.terminate();

      worker.removeAllListeners();
    }
  }
}
