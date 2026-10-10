import { expect, spyOn, test } from "bun:test";
import { MessageChannel } from "node:worker_threads";
import { type QuickJSContext, type Scope } from "quickjs-emscripten";
import { connectGuestToolsToMainThread } from "../src/worker-tool-bridge";
import { executeEngine } from "../src/sandbox-engine";
import { executeLocally } from "./local-tools";
import { rejectionOf } from "./rejection";

test("worker-side posting failures bypass guest catch and release transport listeners", async () => {
  const { port1, port2 } = new MessageChannel();
  using ports = new DisposableStack();
  ports.defer(() => port1.close());
  ports.defer(() => port2.close());
  using cleanup = new DisposableStack();
  const failure = new Error("Private worker transport failure");
  using post = spyOn(port1, "postMessage").mockImplementation(() => {
    throw failure;
  });
  const result = await rejectionOf(
    executeEngine('try { return await tools.read(); } catch { return "caught"; }', (vm, scope) =>
      connectGuestToolsToMainThread(vm, ["read"], port1, scope, cleanup),
    ),
  );
  expect(result.reason).toBe(failure);
  expect(post).toHaveBeenCalledTimes(1);
  cleanup.dispose();
  for (const name of ["message", "messageerror", "close"]) {
    expect(port1.listenerCount(name)).toBe(0);
  }
});

for (const [name, event, message] of [
  ["deserialization failure", "messageerror", "Sandbox tool reply could not be deserialized."],
  ["port closure", "close", "Sandbox tool transport closed before completion."],
] as const) {
  test(`${name} rejects execution while the engine waits for a tool reply`, async () => {
    const { port1, port2 } = new MessageChannel();
    using ports = new DisposableStack();
    ports.defer(() => port1.close());
    ports.defer(() => port2.close());
    using cleanup = new DisposableStack();
    // Failing during setup would not exercise the engine's idle host-call wait.
    port2.once("message", () => port1.emit(event, new Error("Injected transport failure")));
    const result = await rejectionOf(
      executeEngine('try { return await tools.read(); } catch { return "caught"; }', (vm, scope) =>
        connectGuestToolsToMainThread(vm, ["read"], port1, scope, cleanup),
      ),
    );
    expect(result.reason).toBeInstanceOf(Error);
    if (result.reason instanceof Error) expect(result.reason.message).toBe(message);
    cleanup.dispose();
    expect(port1.listenerCount("message")).toBe(0);
  });
}

test("partial remote listener setup disposes the VM and bridge scope and removes listeners", async () => {
  const { port1, port2 } = new MessageChannel();
  using ports = new DisposableStack();
  ports.defer(() => port1.close());
  ports.defer(() => port2.close());
  using cleanup = new DisposableStack();
  const failure = new Error("Remote listener setup failed");
  const resources: { vm: QuickJSContext; scope: Scope }[] = [];
  const add = port1.on.bind(port1);
  using on = spyOn(port1, "on").mockImplementation((...args: Parameters<typeof port1.on>) => {
    if (args[0] === "messageerror") throw failure;
    return add(...args);
  });
  const result = await rejectionOf(
    executeEngine("return 42;", (vm, scope) => {
      resources.push({ vm, scope });
      return connectGuestToolsToMainThread(vm, ["read"], port1, scope, cleanup);
    }),
  );
  expect(result.reason).toBe(failure);
  expect(on).toHaveBeenCalledWith("messageerror", expect.any(Function));
  expect(resources).toHaveLength(1);
  for (const { vm, scope } of resources) {
    expect(vm.alive).toBe(false);
    expect(vm.runtime.alive).toBe(false);
    expect(scope.alive).toBe(false);
  }
  cleanup.dispose();
  for (const name of ["message", "messageerror", "close"]) {
    expect(port1.listenerCount(name)).toBe(0);
  }
  expect(await executeLocally("return 42;")).toEqual({ ok: true, value: 42 });
});
