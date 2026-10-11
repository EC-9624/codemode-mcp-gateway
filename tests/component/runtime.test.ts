import { describe, expect, test } from "bun:test";
import { createVm } from "../../src/runtime";

describe("runtime setup", () => {
  test("creates a fresh context and runtime for each call", async () => {
    using first = await createVm();
    using second = await createVm();
    expect(first.runtime).not.toBe(second.runtime);

    using written = first.evalCode("globalThis.marker = 3;");
    expect(written.error).toBeUndefined();
    using read = second.evalCode("typeof marker;");
    expect(read.error).toBeUndefined();
    if (!read.error) expect(second.getString(read.value)).toBe("undefined");
  });

  test("disposing the context also disposes its runtime", async () => {
    const vm = await createVm();
    const runtime = vm.runtime;
    {
      using owner = vm;
      expect(owner.alive).toBe(true);
      expect(runtime.alive).toBe(true);
    }

    expect(vm.alive).toBe(false);
    expect(runtime.alive).toBe(false);
  });

  test("enforces the guest memory limit and remains usable after allocation failure", async () => {
    using vm = await createVm();
    using oversized = vm.evalCode("new ArrayBuffer(128 * 1024 * 1024);");
    expect(oversized.error).toBeDefined();
    using recovered = vm.evalCode("1 + 2;");
    expect(recovered.error).toBeUndefined();
    if (!recovered.error) expect(vm.getNumber(recovered.value)).toBe(3);
  });
});
