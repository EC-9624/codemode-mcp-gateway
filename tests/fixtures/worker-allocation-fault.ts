import { QuickJSContext } from "quickjs-emscripten";

QuickJSContext.prototype.newPromise = () => {
  throw new Error("Private worker allocation details");
};

// A static import would start the real entry before the worker-local fault is installed.
await import("../../src/codemode/runtime/worker");
