import { parentPort, workerData } from "node:worker_threads";

if (parentPort === null) throw new Error("Runtime probe requires a worker port.");

if (workerData === "wasm") {
  const memory = new WebAssembly.Memory({ initial: 256 });
  const bytes = new Uint8Array(memory.buffer);
  bytes[0] = 42;
  if (bytes[0] !== 42) throw new Error("WASM probe failed.");
} else if (workerData !== "empty") {
  throw new Error("Unknown worker workload.");
}

parentPort.postMessage(42);
parentPort.close();
