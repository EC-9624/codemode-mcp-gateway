import { describe, expect, spyOn, test } from "bun:test";
import { DEFAULT_LIMITS } from "../../src/execution-limits";
import { executeEngine } from "../../src/sandbox-engine";
import { ToolResult } from "../../src/sandbox";
import { superviseWorker } from "../../src/worker-execution";
import { expectDisposedExecution, type ExecutionResources } from "../support/disposal";
import { executionErrorOf } from "../support/execution-error";
import { installLocalToolBridge } from "../support/local-tools";
import { toolWorker } from "../support/workers";

describe("worker-side admission", () => {
  test.each([
    [
      "total",
      { maxToolCalls: 2, maxConcurrentToolCalls: 10 },
      "tool-calls",
      "Execution exceeded the 2 tool-call limit.",
    ],
    [
      "concurrent",
      { maxToolCalls: 10, maxConcurrentToolCalls: 2 },
      "concurrent-tool-calls",
      "Execution exceeded the 2 concurrent tool-call limit.",
    ],
  ] as const)(
    "bounds deferred allocations at the %s limit and disposes owned resources",
    async (_name, limits, resource, message) => {
      const resources: ExecutionResources[] = [];
      const late = Promise.withResolvers<ToolResult>();
      using cleanup = new DisposableStack();
      cleanup.defer(() => late.resolve(ToolResult.success()));
      let allocations = 0;
      let calls = 0;

      const result = await executeEngine(
        "for (let i = 0; i < 100000; i++) { try { tools.read(); } catch {} } while (true) {}",
        { ...DEFAULT_LIMITS, timeoutMs: 1000 },
        (vm, scope) => {
          resources.push({ vm, scope });
          const newPromise = vm.newPromise.bind(vm);

          const allocate = spyOn(vm, "newPromise").mockImplementation(() => {
            allocations++;

            return newPromise();
          });

          cleanup.defer(() => allocate.mockRestore());

          return installLocalToolBridge(
            vm,
            {
              read: () => {
                calls++;

                return late.promise;
              },
            },
            scope,
            limits,
          );
        },
      );

      expect(result).toEqual({
        ok: false,
        error: { kind: "limit", resource, maximum: 2, message },
      });
      expect(allocations).toBe(2);
      expect(calls).toBe(2);
      expectDisposedExecution(resources);
    },
  );

  test("preserves a call limit triggered during guest error conversion", async () => {
    const result = await executeEngine(
      'await tools.read(); throw { get message() { tools.read(); return "Guest failure"; } };',
      { ...DEFAULT_LIMITS, timeoutMs: 1000 },
      (vm, scope) =>
        installLocalToolBridge(vm, { read: () => ToolResult.success(42) }, scope, {
          maxToolCalls: 1,
          maxConcurrentToolCalls: 10,
        }),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "limit",
        resource: "tool-calls",
        maximum: 1,
        message: "Execution exceeded the 1 tool-call limit.",
      },
    });
  });
});

describe("parent-side admission", () => {
  test("enforces total calls independently of the worker's larger budget", async () => {
    const worker = toolWorker("for (let i = 0; i < 3; i++) await tools.read();");
    let calls = 0;

    const report = await superviseWorker(
      worker,
      new Map([["read", () => ToolResult.success(++calls)]]),
      undefined,
      { maxToolCalls: 2, maxConcurrentToolCalls: 10 },
    );

    expect(report).toEqual({
      result: {
        ok: false,
        error: {
          kind: "limit",
          resource: "tool-calls",
          maximum: 2,
          message: "Execution exceeded the 2 tool-call limit.",
        },
      },
      calls: [
        { callId: 1, name: "read", status: "completed", result: { ok: true, json: "1" } },
        { callId: 2, name: "read", status: "completed", result: { ok: true, json: "2" } },
      ],
    });
    expect(calls).toBe(2);
  });

  test("enforces concurrency independently, aborts pending tools, and discards late responses", async () => {
    const worker = toolWorker("return await Promise.all([tools.read(), tools.read()]);");
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));
    const signals: AbortSignal[] = [];
    let conversions = 0;
    using post = spyOn(worker, "postMessage");

    const report = await superviseWorker(
      worker,
      new Map([
        [
          "read",
          (_args, { signal }) => {
            signals.push(signal);

            return late.promise;
          },
        ],
      ]),
      undefined,
      { maxToolCalls: 100, maxConcurrentToolCalls: 1 },
    );

    expect(report).toEqual({
      result: {
        ok: false,
        error: {
          kind: "limit",
          resource: "concurrent-tool-calls",
          maximum: 1,
          message: "Execution exceeded the 1 concurrent tool-call limit.",
        },
      },
      calls: [{ callId: 1, name: "read", status: "interrupted", reason: "concurrency-limit" }],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);

    late.resolve(
      ToolResult.success({
        toJSON() {
          conversions++;

          return 42;
        },
      }),
    );
    await Bun.sleep(0);

    expect(conversions).toBe(0);
    expect(post).not.toHaveBeenCalled();
    expect(report.calls).toEqual([
      { callId: 1, name: "read", status: "interrupted", reason: "concurrency-limit" },
    ]);
    for (const name of ["message", "messageerror", "exit", "error"]) {
      expect(worker.listenerCount(name)).toBe(0);
    }
  });

  test("keeps a limit interruption reason when worker cleanup fails", async () => {
    const worker = toolWorker("tools.read(); tools.read();");
    const terminateWorker = worker.terminate.bind(worker);
    const cause = new Error("Termination failed");
    const late = Promise.withResolvers<ToolResult>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => late.resolve(ToolResult.success()));

    using terminate = spyOn(worker, "terminate").mockImplementation(async () => {
      await terminateWorker();
      throw cause;
    });

    const error = await executionErrorOf(
      superviseWorker(worker, new Map([["read", () => late.promise]]), undefined, {
        maxToolCalls: 1,
        maxConcurrentToolCalls: 1,
      }),
    );

    expect(error.cause).toBe(cause);
    expect(error.calls).toEqual([
      { callId: 1, name: "read", status: "interrupted", reason: "call-limit" },
    ]);
    expect(terminate).toHaveBeenCalledTimes(1);
  });
});
