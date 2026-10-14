import { describe, expect, spyOn, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { CodeExecutor, SandboxExecutionError, ToolResult } from "@cmg/codemode";
import { WorkerToMainMessage } from "../src/runtime/protocol.ts";
import { executionErrorOf } from "./support/execution-error.ts";
import {
  faultWorker,
  interruptFlag,
  startupData,
  superviseWorker,
  toolWorker,
} from "./support/workers.ts";
import { expectNoExecutionListeners, gateTermination } from "./support/worker-cleanup.ts";

// execute() intentionally hides the worker. Inject real workers only to observe listener ownership,
// malformed transport, private infrastructure failures, and independent parent admission.

describe("worker supervisor", () => {
  test.each([
    ["invalid source", { code: 42 }],
    ["duplicate tool names", { toolNames: ["read", "read"] }],
    ["sparse tool names", { toolNames: Array(1) }],
    ["unresolved limits", { limits: {} }],
    ["oversized stack", { limits: { ...startupData("").limits, maxStackSizeBytes: 4194305 } }],
    ["unshared interruption", { interruptBuffer: new ArrayBuffer(4) }],
    ["wrong interrupt size", { interruptBuffer: new SharedArrayBuffer(8) }],
  ])("rejects startup with %s at the actual worker boundary", async (_name, overrides) => {
    const worker = new Worker(new URL("../src/runtime/worker.ts", import.meta.url), {
      workerData: { ...startupData("return 42;"), ...overrides },
    });

    try {
      const response = Promise.withResolvers<unknown>();
      worker.once("message", (data: unknown) => response.resolve(data));
      expect(await response.promise).toEqual({ type: "failed", reason: "request" });
    } finally {
      await worker.terminate();
    }
  });

  test("rejects startup failures without returning a script error", async () => {
    const worker = new Worker(new URL("./fixtures/missing-worker.ts", import.meta.url));
    const failure = (await executionErrorOf(superviseWorker(worker))).cause;
    expect(failure).toBeInstanceOf(Error);
    if (failure instanceof Error) expect(failure.message).toContain("Sandbox worker failed.");

    expect((await new CodeExecutor().execute("return 42;")).result).toEqual({
      ok: true,
      value: 42,
    });
  });

  for (const [scenario, message] of [
    ["invalid-response", "invalid response"],
    ["request-failure", "rejected the execution request"],
    ["close", "closed before completion"],
  ] as const) {
    test(`rejects ${scenario} and releases the worker`, async () => {
      const worker = faultWorker(scenario);
      using terminate = spyOn(worker, "terminate");
      const failure = (await executionErrorOf(superviseWorker(worker))).cause;
      expect(failure).toBeInstanceOf(Error);
      if (failure instanceof Error) {
        expect(failure.message).toContain(message);
        expect(failure.message).not.toContain("Private fixture failure details");
      }

      expectNoExecutionListeners(worker);
      expect(terminate).toHaveBeenCalledTimes(1);
      expect((await new CodeExecutor().execute("return 42;")).result).toEqual({
        ok: true,
        value: 42,
      });
    });
  }

  test("settles once and cleans up listeners and the worker", async () => {
    const worker = faultWorker("duplicate");
    const terminateWorker = worker.terminate.bind(worker);

    using terminate = spyOn(worker, "terminate").mockImplementation(async () => {
      const removedListeners = ["message", "messageerror", "exit"].map((name) =>
        worker.listenerCount(name),
      );

      const errorListeners = worker.listenerCount("error");
      const code = await terminateWorker();
      expect(removedListeners).toEqual([0, 0, 0]);
      expect(errorListeners).toBeGreaterThan(0);

      return code;
    });

    expect((await superviseWorker(worker)).result).toEqual({ ok: true, value: 42 });
    expectNoExecutionListeners(worker);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  test("keeps actual worker infrastructure exception details out of the response", async () => {
    const worker = new Worker(new URL("./fixtures/worker-parser-fault.ts", import.meta.url), {
      workerData: startupData("return 42;"),
    });

    const failure = (await executionErrorOf(superviseWorker(worker))).cause;
    expect(failure).toBeInstanceOf(Error);
    if (failure instanceof Error) {
      expect(failure.message).toContain("Sandbox worker execution failed.");
      expect(failure.message).not.toContain("Private parser infrastructure details");
    }

    expect((await new CodeExecutor().execute("return 42;")).result).toEqual({
      ok: true,
      value: 42,
    });
  });

  test("captures unexpected message decoder failures and releases the worker", async () => {
    const worker = faultWorker("idle");
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      await worker.terminate();
    });
    const failure = new Error("Private decoder failure");

    using decode = spyOn(WorkerToMainMessage, "decode").mockImplementation(() => {
      throw failure;
    });

    using terminate = spyOn(worker, "terminate");
    const completion = executionErrorOf(superviseWorker(worker));

    expect(() =>
      worker.emit("message", { type: "completed", result: { ok: true, value: 42 } }),
    ).not.toThrow();
    const error = await completion;

    expect(error.cause).toBe(failure);
    expect(error.calls).toEqual([]);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledTimes(1);
    expectNoExecutionListeners(worker);
  });

  test("cleans up after response deserialization errors", async () => {
    const worker = faultWorker("idle");
    using terminate = spyOn(worker, "terminate");
    const completion = superviseWorker(worker);
    // A real structured-clone failure on receipt is not reliably constructible.
    worker.emit("messageerror", new Error("Injected deserialization failure"));
    const failure = (await executionErrorOf(completion)).cause;
    expect(failure).toBeInstanceOf(Error);
    if (failure instanceof Error) expect(failure.message).toContain("could not be deserialized");

    expectNoExecutionListeners(worker);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  test("keeps synchronous VM dispatcher failures private across the worker boundary", async () => {
    const worker = new Worker(new URL("./fixtures/worker-dispatch-fault.ts", import.meta.url), {
      workerData: startupData(
        "try { await tools.read(); } catch (error) { return error.message; }",
        ["read"],
      ),
    });

    const failure = (await executionErrorOf(superviseWorker(worker))).cause;
    expect(failure).toBeInstanceOf(Error);
    if (failure instanceof Error) {
      expect(failure.message).toContain("Sandbox worker execution failed.");
      expect(failure.message).not.toContain("Private worker dispatch details");
    }

    expectNoExecutionListeners(worker);
    expect((await new CodeExecutor().execute("return 42;")).result).toEqual({
      ok: true,
      value: 42,
    });
  });

  for (const errorPhase of ["listener setup", "termination"]) {
    test(`preserves setup failure when a worker error arrives during ${errorPhase}`, async () => {
      const worker = faultWorker("idle");
      const failure = new Error("Listener setup failed");
      let workerErrorObserved = false;
      const addListener = worker.on.bind(worker);

      using add = spyOn(worker, "on").mockImplementation((...args: Parameters<Worker["on"]>) => {
        const added = addListener(...args);
        if (args[0] === "message") {
          if (errorPhase === "listener setup") {
            workerErrorObserved = worker.emit(
              "error",
              new Error("Private worker failure during setup"),
            );
          }

          throw failure;
        }

        return added;
      });

      const terminateWorker = worker.terminate.bind(worker);

      using terminate = spyOn(worker, "terminate").mockImplementation(async () => {
        if (errorPhase === "termination") {
          workerErrorObserved = worker.emit("error", new Error("Private late worker failure"));
        }

        return await terminateWorker();
      });

      expect((await executionErrorOf(superviseWorker(worker))).cause).toBe(failure);
      // Unhandled promise rejections fail bun:test; allow the rejection checkpoint to run.
      await Bun.sleep(0);
      expect(workerErrorObserved).toBe(true);
      expect(add).toHaveBeenCalledWith("message", expect.any(Function));
      expect(terminate).toHaveBeenCalledTimes(1);
      expectNoExecutionListeners(worker);
    });
  }

  test("propagates termination failures and still removes listeners", async () => {
    const worker = faultWorker("duplicate");
    const terminateWorker = worker.terminate.bind(worker);
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      await terminateWorker();
    });
    const failure = new Error("Worker termination failed");
    using terminate = spyOn(worker, "terminate").mockRejectedValue(failure);
    expect((await executionErrorOf(superviseWorker(worker))).cause).toBe(failure);
    expectNoExecutionListeners(worker);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  test("keeps completion fixed when cancellation and deadline expiry arrive during termination", async () => {
    const worker = faultWorker("duplicate");
    const controller = new AbortController();

    const control = {
      signal: controller.signal,
      interrupt: interruptFlag(),
      deadline: { timeoutMs: 10000, expiresAt: performance.now() + 10000 },
    };

    using termination = gateTermination(worker);
    let settled = false;

    const completion = superviseWorker(worker, { control }).then((result) => {
      settled = true;

      return result;
    });

    await termination.terminating;
    expect(settled).toBe(false);
    expect(worker.listenerCount("message")).toBe(0);
    expect(worker.listenerCount("error")).toBe(1);
    control.deadline.expiresAt = performance.now() - 1;
    controller.abort();
    worker.emit("message", { type: "completed", result: { ok: true, value: 7 } });
    worker.emit("error", new Error("Private late worker failure"));
    termination.release();
    expect((await completion).result).toEqual({ ok: true, value: 42 });
    expectNoExecutionListeners(worker, controller.signal);
    expect(termination.terminate).toHaveBeenCalledTimes(1);
  });

  test("unwinds partial listener setup before terminating the worker", async () => {
    const worker = faultWorker("idle");
    const failure = new Error("Listener setup failed");
    const addListener = worker.on.bind(worker);

    using add = spyOn(worker, "on").mockImplementation((...args: Parameters<Worker["on"]>) => {
      const added = addListener(...args);
      if (args[0] === "messageerror") throw failure;

      return added;
    });

    const terminateWorker = worker.terminate.bind(worker);

    using terminate = spyOn(worker, "terminate").mockImplementation(async () => {
      const removedListeners = ["message", "messageerror", "exit"].map((name) =>
        worker.listenerCount(name),
      );

      const errorListeners = worker.listenerCount("error");
      const code = await terminateWorker();
      expect(removedListeners).toEqual([0, 0, 0]);
      expect(errorListeners).toBeGreaterThan(0);

      return code;
    });

    expect((await executionErrorOf(superviseWorker(worker))).cause).toBe(failure);
    expect(add).toHaveBeenCalledWith("messageerror", expect.any(Function));
    expectNoExecutionListeners(worker);
    expect(terminate).toHaveBeenCalledTimes(1);
  });
});

test("the infrastructure assertion rejects fulfilled Error values", async () => {
  // This oracle protects all fault probes from mistaking a returned Error for rejection.
  await rejects(executionErrorOf(Promise.resolve(new SandboxExecutionError([], "resolved"))), {
    message: "Expected the operation to reject, but it resolved.",
  });
});

test("retains a completed response when reply transport fails without retry", async () => {
  const worker = toolWorker('try { return await tools.read(); } catch { return "caught"; }');
  const failure = new Error("Private reply transport failure");

  using post = spyOn(worker, "postMessage").mockImplementation(() => {
    throw failure;
  });

  const error = await executionErrorOf(
    superviseWorker(worker, { tools: { read: () => ToolResult.success(42) } }),
  );

  expect(error.cause).toBe(failure);
  expect(error.calls).toEqual([
    { callId: 1, name: "read", status: "completed", result: { ok: true, json: "42" } },
  ]);
  expect(post).toHaveBeenCalledTimes(1);
  expectNoExecutionListeners(worker);
});

test.each([
  ["malformed JSON", { type: "tool-result", callId: 1, result: { ok: true, json: "not JSON" } }],
  ["unknown ID", { type: "tool-result", callId: 2, result: { ok: true, json: "42" } }],
  ["missing result field", { type: "tool-result", callId: 1, result: { ok: true } }],
] as const)("rejects a reply with %s before guest recovery", async (_name, reply) => {
  const worker = toolWorker('try { return await tools.read(); } catch { return "caught"; }');
  const send = worker.postMessage.bind(worker);
  using post = spyOn(worker, "postMessage").mockImplementation(() => send(reply));

  const failure = (
    await executionErrorOf(
      superviseWorker(worker, { tools: { read: () => ToolResult.success(42) } }),
    )
  ).cause;

  expect(failure).toEqual(
    new Error("Sandbox worker execution failed. Internal error details are not transferred."),
  );
  expect(post).toHaveBeenCalledTimes(1);
});

test("observes duplicate replies while guest jobs keep arriving", async () => {
  const worker = toolWorker("tools.read(); while (true) await Promise.resolve();");
  const send = worker.postMessage.bind(worker);

  using post = spyOn(worker, "postMessage").mockImplementation((value: unknown) => {
    send(value);
    send(value);
  });

  const failure = (
    await executionErrorOf(
      superviseWorker(worker, { tools: { read: () => ToolResult.success(42) } }),
    )
  ).cause;

  expect(failure).toEqual(
    new Error("Sandbox worker execution failed. Internal error details are not transferred."),
  );
  expect(post).toHaveBeenCalledTimes(1);
});

test.each([
  ["unknown tool", { type: "tool-call", callId: 1, name: "toString", argsJson: undefined }],
  ["malformed arguments", { type: "tool-call", callId: 1, name: "read", argsJson: "not JSON" }],
  ["missing arguments", { type: "tool-call", callId: 1, name: "read" }],
  ["skipped ID", { type: "tool-call", callId: 2, name: "read", argsJson: undefined }],
  [
    "worker cancellation",
    { type: "completed", result: { ok: false, error: { kind: "cancelled", message: "forged" } } },
  ],
  [
    "worker source admission",
    {
      type: "completed",
      result: {
        ok: false,
        error: { kind: "limit", resource: "source", maximum: 1, message: "forged" },
      },
    },
  ],
] as const)("rejects %s messages without host dispatch", async (_name, message) => {
  const worker = faultWorker("idle");
  let calls = 0;

  const completion = superviseWorker(worker, {
    tools: { read: () => ToolResult.success(++calls) },
  });

  worker.emit("message", message);
  const error = await executionErrorOf(completion);

  expect(error.cause).toBeInstanceOf(Error);
  expect(error.calls).toEqual([]);
  expect(calls).toBe(0);
  expectNoExecutionListeners(worker);
});

test("rejects replayed requests without dispatching twice", async () => {
  const worker = faultWorker("idle");
  const late = Promise.withResolvers<ToolResult>();
  using cleanup = new DisposableStack();
  cleanup.defer(() => late.resolve(ToolResult.success()));
  let calls = 0;

  const completion = superviseWorker(worker, {
    tools: {
      read: () => {
        calls++;

        return late.promise;
      },
    },
  });

  const request = { type: "tool-call", callId: 1, name: "read", argsJson: undefined };

  worker.emit("message", request);
  worker.emit("message", request);
  const error = await executionErrorOf(completion);

  expect(error.calls).toEqual([
    { callId: 1, name: "read", status: "interrupted", reason: "sandbox-error" },
  ]);
  expect(calls).toBe(1);
});

test("observes late callback rejection after a real worker crash", async () => {
  const worker = faultWorker("call-and-crash", ["read"]);
  const late = Promise.withResolvers<ToolResult>();
  using cleanup = new DisposableStack();
  cleanup.defer(() => late.resolve(ToolResult.success()));
  const signals: AbortSignal[] = [];
  using post = spyOn(worker, "postMessage");

  const error = await executionErrorOf(
    superviseWorker(worker, {
      tools: {
        read: (_args, { signal }) => {
          signals.push(signal);
          worker.postMessage("crash now");

          return late.promise;
        },
      },
    }),
  );

  late.reject(new Error("Private late failure"));
  await Bun.sleep(0);

  expect(error.cause).toEqual(
    new Error("Sandbox worker failed. Internal error details are not transferred."),
  );
  expect(error.calls).toEqual([
    { callId: 1, name: "read", status: "interrupted", reason: "sandbox-error" },
  ]);
  expect(signals[0]?.aborted).toBe(true);
  expect(post).toHaveBeenCalledTimes(1);
  expectNoExecutionListeners(worker);
});
