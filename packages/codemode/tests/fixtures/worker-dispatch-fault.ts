import { QuickJSContext } from "quickjs-emscripten";

QuickJSContext.prototype.getString = () => {
  throw new Error("Private worker dispatch details");
};

// A static import would start the real entry before the worker-local fault is installed.
await import("../../src/runtime/worker");
