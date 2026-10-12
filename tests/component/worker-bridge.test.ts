import { expect, spyOn, test } from "bun:test";
import { MessageChannel } from "node:worker_threads";
import { DEFAULT_LIMITS } from "../../src/codemode/runtime/limits";
import { installWorkerToolBridge } from "../../src/codemode/runtime/worker-bridge";
import { executeEngine } from "../../src/codemode/runtime/engine";
import { ToolReply } from "../../src/codemode/runtime/protocol";
import { expectDisposedExecution, type ExecutionResources } from "../support/disposal";
import { executeLocally } from "../support/local-tools";
import { rejectionOf } from "../support/rejection";
import { interruptFlag } from "../support/workers";

test("worker-side posting failures bypass guest catch and release transport listeners", async () => {
  using channel = openChannel();
  const port1 = channel.port1;
  using cleanup = new DisposableStack();
  const failure = new Error("Private worker transport failure");

  using post = spyOn(port1, "postMessage").mockImplementation(() => {
    throw failure;
  });

  const result = await rejectionOf(
    executeEngine(
      'try { return await tools.read(); } catch { return "caught"; }',
      { ...DEFAULT_LIMITS, timeoutMs: 1000 },
      (vm, scope) => installWorkerToolBridge(vm, ["read"], port1, scope, cleanup, DEFAULT_LIMITS),
      interruptFlag(),
    ),
  );

  expect(result.reason).toBe(failure);
  expect(post).toHaveBeenCalledTimes(1);
  cleanup.dispose();
  for (const name of ["message", "messageerror", "close"]) {
    expect(port1.listenerCount(name)).toBe(0);
  }
});

test("reply decoder exceptions reject execution and dispose resources without guest recovery", async () => {
  using channel = openChannel();
  using cleanup = new DisposableStack();
  const failure = new Error("Private reply decoder failure");
  const resources: ExecutionResources[] = [];
  const started = Promise.withResolvers<void>();
  channel.port2.once("message", () => started.resolve());

  using decode = spyOn(ToolReply, "decode").mockImplementation(() => {
    throw failure;
  });

  const completion = rejectionOf(
    executeEngine(
      'try { return await tools.read(); } catch { return "caught"; }',
      { ...DEFAULT_LIMITS, timeoutMs: 1000 },
      (vm, scope) => {
        resources.push({ vm, scope });

        return installWorkerToolBridge(vm, ["read"], channel.port1, scope, cleanup, DEFAULT_LIMITS);
      },
      interruptFlag(),
    ),
  );

  await started.promise;
  expect(() =>
    channel.port1.emit("message", {
      type: "tool-result",
      callId: 1,
      result: { ok: true, json: "42" },
    }),
  ).not.toThrow();
  const rejected = await completion;

  expect(rejected.reason).toBe(failure);
  expect(decode).toHaveBeenCalledTimes(1);
  expectDisposedExecution(resources);
  cleanup.dispose();
  for (const name of ["message", "messageerror", "close"]) {
    expect(channel.port1.listenerCount(name)).toBe(0);
  }
});

for (const [name, event, message] of [
  ["deserialization failure", "messageerror", "Sandbox tool reply could not be deserialized."],
  ["port closure", "close", "Sandbox tool transport closed before completion."],
] as const) {
  test(`${name} rejects execution while the engine waits for a tool reply`, async () => {
    using channel = openChannel();
    const { port1, port2 } = channel;
    using cleanup = new DisposableStack();
    // Failing during setup would not exercise the engine's idle host-call wait.
    port2.once("message", () => port1.emit(event, new Error("Injected transport failure")));

    const result = await rejectionOf(
      executeEngine(
        'try { return await tools.read(); } catch { return "caught"; }',
        { ...DEFAULT_LIMITS, timeoutMs: 1000 },
        (vm, scope) => installWorkerToolBridge(vm, ["read"], port1, scope, cleanup, DEFAULT_LIMITS),
        interruptFlag(),
      ),
    );

    expect(result.reason).toBeInstanceOf(Error);
    if (result.reason instanceof Error) expect(result.reason.message).toBe(message);

    cleanup.dispose();
    expect(port1.listenerCount("message")).toBe(0);
  });
}

test("partial remote listener setup disposes the VM and bridge scope and removes listeners", async () => {
  using channel = openChannel();
  const port1 = channel.port1;
  using cleanup = new DisposableStack();
  const failure = new Error("Remote listener setup failed");
  const resources: ExecutionResources[] = [];
  const add = port1.on.bind(port1);

  using on = spyOn(port1, "on").mockImplementation((...args: Parameters<typeof port1.on>) => {
    if (args[0] === "messageerror") throw failure;

    return add(...args);
  });

  const result = await rejectionOf(
    executeEngine(
      "return 42;",
      { ...DEFAULT_LIMITS, timeoutMs: 1000 },
      (vm, scope) => {
        resources.push({ vm, scope });

        return installWorkerToolBridge(vm, ["read"], port1, scope, cleanup, DEFAULT_LIMITS);
      },
      interruptFlag(),
    ),
  );

  expect(result.reason).toBe(failure);
  expect(on).toHaveBeenCalledWith("messageerror", expect.any(Function));
  expectDisposedExecution(resources);
  cleanup.dispose();
  for (const name of ["message", "messageerror", "close"]) {
    expect(port1.listenerCount(name)).toBe(0);
  }

  expect(await executeLocally("return 42;")).toEqual({ ok: true, value: 42 });
});

function openChannel() {
  const channel = new MessageChannel();

  return {
    port1: channel.port1,
    port2: channel.port2,
    [Symbol.dispose]() {
      channel.port1.close();
      channel.port2.close();
    },
  };
}
