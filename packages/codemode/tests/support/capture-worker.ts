import { spyOn } from "bun:test";
import { Worker } from "node:worker_threads";

/** Observe the real worker dependency without exposing a worker hook on CodeExecutor. */
export function captureWorker() {
  const captured = Promise.withResolvers<Worker>();
  const listener = spyOn(Worker.prototype, "on");
  const on = listener.getMockImplementation();
  if (on === undefined) throw new Error("Expected native worker listener registration");

  listener.mockImplementation(function (this: Worker, ...args: Parameters<Worker["on"]>) {
    const result = on.apply(this, args);
    if (args[0] === "message") captured.resolve(this);

    return result;
  });

  return {
    worker: captured.promise,
    [Symbol.dispose]() {
      listener.mockRestore();
    },
  };
}
