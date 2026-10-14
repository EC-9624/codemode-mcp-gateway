import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) throw new Error("Memory probe requires a parent worker port.");

if (
  workerData !== "worker" &&
  workerData !== "wasm" &&
  workerData !== "wasm-memory" &&
  workerData !== "quickjs"
)
  throw new Error("Unknown memory probe workload.");

if (workerData === "wasm-memory") {
  const memory = new WebAssembly.Memory({ initial: 256 });
  const bytes = new Uint8Array(memory.buffer);
  bytes[0] = 42;
  if (bytes[0] !== 42) throw new Error("WebAssembly memory write failed.");
}

if (workerData === "wasm") {
  // (module (func (export "answer") (result i32) i32.const 42))
  const module = new WebAssembly.Module(
    new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 7, 10, 1, 6, 97, 110, 115,
      119, 101, 114, 0, 0, 10, 6, 1, 4, 0, 65, 42, 11,
    ]),
  );

  const instance = new WebAssembly.Instance(module);
  const answer = instance.exports.answer;
  if (typeof answer !== "function") throw new Error("WebAssembly function was not exported.");

  const value: unknown = Reflect.apply(answer, undefined, []);
  if (value !== 42) throw new Error("WebAssembly did not evaluate to 42.");
}

if (workerData === "quickjs") {
  const { getQuickJS } = await import("quickjs-emscripten");
  const quickJS = await getQuickJS();
  const vm = quickJS.newContext();
  {
    // newContext owns its associated runtime; dispose the value before both.
    using context = vm;
    context.runtime.setMemoryLimit(64 * 1024 * 1024);
    context.runtime.setMaxStackSize(1024 * 1024);
    using result = context.evalCode("42").unwrap();
    if (context.getNumber(result) !== 42) throw new Error("QuickJS did not evaluate to 42.");
  }

  if (vm.alive || vm.runtime.alive) throw new Error("QuickJS resources survived disposal.");
}

// Default probes mirror CMG's parent termination; "close" tests natural worker exit.
const port = parentPort;
port.on("message", (message: unknown) => {
  if (message === "close") port.close();
});
parentPort.postMessage(42);
