import { describe, expect, spyOn, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { CodemodeSandbox } from "@cmg/codemode";
import { WorkerToMainMessage } from "../../src/runtime/protocol";
import { executionErrorOf } from "../support/execution-error";
import { faultWorker, startupData, superviseWorker } from "../support/workers";
import { expectNoExecutionListeners, gateTermination } from "../support/worker-cleanup";

describe("worker supervisor", () => {
  test("rejects invalid requests at the actual worker boundary", async () => {
    const worker = new Worker(new URL("../../src/runtime/worker.ts", import.meta.url), {
      workerData: { type: "execute", code: 42 },
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
    const worker = new Worker(new URL("../fixtures/missing-worker.ts", import.meta.url));
    const failure = (await executionErrorOf(superviseWorker(worker))).cause;
    expect(failure).toBeInstanceOf(Error);
    if (failure instanceof Error) expect(failure.message).toContain("Sandbox worker failed.");

    expect((await new CodemodeSandbox().execute("return 42;")).result).toEqual({
      ok: true,
      value: 42,
    });
  });

  for (const [scenario, message] of [
    ["invalid-response", "invalid response"],
    ["execution-failure", "execution failed"],
    ["request-failure", "rejected the execution request"],
    ["crash", "Sandbox worker failed."],
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
      expect((await new CodemodeSandbox().execute("return 42;")).result).toEqual({
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
    const worker = new Worker(new URL("../fixtures/worker-parser-fault.ts", import.meta.url), {
      workerData: startupData("return 42;"),
    });

    const failure = (await executionErrorOf(superviseWorker(worker))).cause;
    expect(failure).toBeInstanceOf(Error);
    if (failure instanceof Error) {
      expect(failure.message).toContain("Sandbox worker execution failed.");
      expect(failure.message).not.toContain("Private parser infrastructure details");
    }

    expect((await new CodemodeSandbox().execute("return 42;")).result).toEqual({
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
    const worker = new Worker(new URL("../fixtures/worker-dispatch-fault.ts", import.meta.url), {
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
    expect((await new CodemodeSandbox().execute("return 42;")).result).toEqual({
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

  test("awaits termination and observes late errors without changing a completed result", async () => {
    const worker = faultWorker("duplicate");
    using termination = gateTermination(worker);
    let settled = false;

    const completion = superviseWorker(worker).then((result) => {
      settled = true;

      return result;
    });

    await termination.terminating;
    expect(settled).toBe(false);
    expect(worker.listenerCount("message")).toBe(0);
    expect(worker.listenerCount("error")).toBe(1);
    worker.emit("error", new Error("Private late worker failure"));
    termination.release();
    expect((await completion).result).toEqual({ ok: true, value: 42 });
    expectNoExecutionListeners(worker);
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
