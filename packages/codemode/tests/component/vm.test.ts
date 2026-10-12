import { describe, expect, spyOn, test } from "bun:test";
import { getQuickJS } from "quickjs-emscripten";
import { createVm } from "../../src/runtime/vm";
import { rejectionOf } from "../support/rejection";

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

  test("preserves setup and disposal failures without retrying cleanup", async () => {
    const quickJS = await getQuickJS();
    const vm = quickJS.newContext();
    const dispose = vm.dispose.bind(vm);
    using cleanup = new DisposableStack();
    cleanup.defer(() => {
      if (vm.alive) dispose();
    });
    const setupFailure = new Error("Stack configuration failed");
    const cleanupFailure = new Error("Context disposal failed");
    using context = spyOn(quickJS, "newContext").mockReturnValue(vm);

    using stack = spyOn(vm.runtime, "setMaxStackSize").mockImplementation(() => {
      throw setupFailure;
    });

    using disposal = spyOn(vm, "dispose").mockImplementation(() => {
      dispose();
      throw cleanupFailure;
    });

    const rejected = await rejectionOf(createVm());

    expect(rejected.reason).toBeInstanceOf(SuppressedError);
    if (rejected.reason instanceof SuppressedError) {
      expect(rejected.reason.error).toBe(cleanupFailure);
      expect(rejected.reason.suppressed).toBe(setupFailure);
    }

    expect(context).toHaveBeenCalledTimes(1);
    expect(stack).toHaveBeenCalledTimes(1);
    expect(disposal).toHaveBeenCalledTimes(1);
    expect(vm.alive).toBe(false);
    expect(vm.runtime.alive).toBe(false);
  });

  test("disposes the context and runtime when limit configuration throws and recovers", async () => {
    const quickJS = await getQuickJS();
    const vm = quickJS.newContext();
    const runtime = vm.runtime;
    const failure = new Error("Stack configuration failed");
    using cleanup = new DisposableStack();
    cleanup.defer(() => {
      if (vm.alive) vm.dispose();
    });

    {
      using context = spyOn(quickJS, "newContext").mockReturnValue(vm);

      using stack = spyOn(runtime, "setMaxStackSize").mockImplementation(() => {
        throw failure;
      });

      const rejected = await rejectionOf(
        createVm({ memoryLimitBytes: 8 * 1024 * 1024, maxStackSizeBytes: 64 * 1024 }),
      );

      expect(rejected.reason).toBe(failure);
      expect(context).toHaveBeenCalledTimes(1);
      expect(stack).toHaveBeenCalledWith(64 * 1024);
      expect(vm.alive).toBe(false);
      expect(runtime.alive).toBe(false);
    }

    using recovered = await createVm();
    using result = recovered.evalCode("1 + 2;");

    expect(result.error).toBeUndefined();
    if (!result.error) expect(recovered.getNumber(result.value)).toBe(3);
  });
});
