import { describe, expect, spyOn, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { execute, ToolResult, type SandboxResult } from "../src/sandbox";
import { superviseWorker, type WorkerDeadline } from "../src/worker-execution";
import { rejectionOf } from "./rejection";
import { faultWorker, toolWorker } from "./workers";

describe("parent deadline", () => {
  for (const [name, totalTimeoutMs] of [
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", NaN],
    ["infinite", Infinity],
    ["overflowing", 2 ** 31],
  ] as const) {
    test(`rejects a ${name} total budget before reading tools`, async () => {
      let reads = 0;
      const failure = (
        await rejectionOf(
          execute(
            "return 42;",
            {
              get read() {
                reads++;
                return () => ToolResult.success();
              },
            },
            { totalTimeoutMs },
          ),
        )
      ).reason;
      expect(failure).toBeInstanceOf(RangeError);
      if (failure instanceof RangeError) {
        expect(failure.message).toBe("totalTimeoutMs must be an integer from 1 to 2147483647.");
      }
      expect(reads).toBe(0);
    });
  }

  test("accepts the minimum total budget", async () => {
    expect(await execute("while (true) {}", {}, { totalTimeoutMs: 1 })).toEqual(timeout(1));
  });

  test("preserves a guest timeout that arrives before the parent deadline", async () => {
    expect(await execute("while (true) {}", {}, { timeoutMs: 50, totalTimeoutMs: 2000 })).toEqual({
      ok: false,
      error: { kind: "timeout", message: "Execution exceeded the 50 ms limit." },
    });
  });

  test("expires while worker startup is stalled and recovers", async () => {
    const deadline = parentDeadline(100);
    const worker = faultWorker("startup-stall");
    using terminate = spyOn(worker, "terminate");
    expect(await superviseWorker(worker, new Map(), deadline)).toEqual(timeout(100));
    expect(Atomics.load(deadline.interrupt, 0)).toBe(1);
    expect(terminate).toHaveBeenCalledTimes(1);
    expectNoExecutionListeners(worker);
    expect(await execute("return 42;", {}, { totalTimeoutMs: 2000 })).toEqual({
      ok: true,
      value: 42,
    });
  });

  test("counts time elapsed before supervisor setup", async () => {
    const deadline = parentDeadline(100);
    deadline.expiresAt = performance.now() - 1;
    const worker = faultWorker("idle");
    expect(await superviseWorker(worker, new Map(), deadline)).toEqual(timeout(100));
    expect(Atomics.load(deadline.interrupt, 0)).toBe(1);
    expectNoExecutionListeners(worker);
  });

  for (const [name, response] of [
    ["completion", { type: "completed", result: { ok: true, value: 42 } }],
    ["tool call", { type: "tool-call", callId: 1, name: "read", argsJson: undefined }],
    ["worker failure", { type: "failed", reason: "execution" }],
  ] as const) {
    test(`rejects a late ${name} before the timer callback can run`, async () => {
      const worker = faultWorker("idle");
      let calls = 0;
      const completion = superviseWorker(
        worker,
        new Map([["read", () => ToolResult.success(++calls)]]),
        parentDeadline(20),
      );
      // Deliberately block the parent: the message handler must consult the clock itself.
      Bun.sleepSync(40);
      worker.emit("message", response);
      expect(await completion).toEqual(timeout(20));
      expect(calls).toBe(0);
      expectNoExecutionListeners(worker);
    });
  }

  for (const phase of ["callback", "result conversion"] as const) {
    test(`drops a reply when synchronous ${phase} exhausts the budget`, async () => {
      const worker = faultWorker("idle");
      let conversions = 0;
      using post = spyOn(worker, "postMessage");
      const completion = superviseWorker(
        worker,
        new Map([
          [
            "read",
            () => {
              if (phase === "callback") Bun.sleepSync(40);
              return ToolResult.success({
                toJSON() {
                  conversions++;
                  if (phase === "result conversion") Bun.sleepSync(40);
                  return 42;
                },
              });
            },
          ],
        ]),
        parentDeadline(20),
      );
      worker.emit("message", { type: "tool-call", callId: 1, name: "read", argsJson: undefined });
      expect(await completion).toEqual(timeout(20));
      expect(conversions).toBe(phase === "callback" ? 0 : 1);
      expect(post).not.toHaveBeenCalled();
    });
  }

  for (const outcome of ["success", "failure"] as const) {
    test(`expires during a host wait and discards late callback ${outcome}`, async () => {
      const deadline = parentDeadline(250);
      const worker = toolWorker("return await tools.read();", 10000, deadline.interrupt.buffer);
      const late = Promise.withResolvers<ToolResult>();
      using cleanup = new DisposableStack();
      cleanup.defer(() => late.resolve(ToolResult.success()));
      let calls = 0;
      let conversions = 0;
      using post = spyOn(worker, "postMessage");
      expect(
        await superviseWorker(
          worker,
          new Map([
            [
              "read",
              () => {
                calls++;
                return late.promise;
              },
            ],
          ]),
          deadline,
        ),
      ).toEqual(timeout(250));
      expect(calls).toBe(1);
      if (outcome === "failure") late.reject(new Error("Private late callback failure"));
      else {
        late.resolve(
          ToolResult.success({
            toJSON() {
              conversions++;
              return 42;
            },
          }),
        );
      }
      await Bun.sleep(0);
      expect(conversions).toBe(0);
      expect(post).not.toHaveBeenCalled();
      expectNoExecutionListeners(worker);
    });
  }

  test("preserves a completion accepted before expiry while awaiting termination", async () => {
    const worker = faultWorker("idle");
    const terminateWorker = worker.terminate.bind(worker);
    const terminating = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => release.resolve());
    using terminate = spyOn(worker, "terminate").mockImplementation(async () => {
      const code = await terminateWorker();
      terminating.resolve();
      await release.promise;
      return code;
    });
    const deadline = parentDeadline(50);
    let settled = false;
    const completion = superviseWorker(worker, new Map(), deadline).then((result) => {
      settled = true;
      return result;
    });
    worker.emit("message", { type: "completed", result: { ok: true, value: 42 } });
    await terminating.promise;
    await Bun.sleep(Math.max(0, deadline.expiresAt - performance.now()) + 20);
    expect(settled).toBe(false);
    worker.emit("error", new Error("Private late worker failure"));
    release.resolve();
    expect(await completion).toEqual({ ok: true, value: 42 });
    expect(terminate).toHaveBeenCalledTimes(1);
    expectNoExecutionListeners(worker);
  });

  test("awaits termination after expiry and ignores late completions and errors", async () => {
    const worker = faultWorker("idle");
    const terminateWorker = worker.terminate.bind(worker);
    const terminating = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => release.resolve());
    const deadline = parentDeadline(20);
    using terminate = spyOn(worker, "terminate").mockImplementation(async () => {
      expect(Atomics.load(deadline.interrupt, 0)).toBe(1);
      expect(worker.listenerCount("message")).toBe(0);
      expect(worker.listenerCount("error")).toBe(1);
      const code = await terminateWorker();
      terminating.resolve();
      await release.promise;
      return code;
    });
    let settled = false;
    const completion = superviseWorker(worker, new Map(), deadline).then((result) => {
      settled = true;
      return result;
    });
    await terminating.promise;
    worker.emit("message", { type: "completed", result: { ok: true, value: 42 } });
    worker.emit("error", new Error("Private late worker failure"));
    expect(settled).toBe(false);
    release.resolve();
    expect(await completion).toEqual(timeout(20));
    expect(terminate).toHaveBeenCalledTimes(1);
    expectNoExecutionListeners(worker);
  });

  test("propagates termination failure after expiry and removes listeners", async () => {
    const worker = faultWorker("idle");
    const terminateWorker = worker.terminate.bind(worker);
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      await terminateWorker();
    });
    const failure = new Error("Worker termination failed");
    using terminate = spyOn(worker, "terminate").mockRejectedValue(failure);
    expect((await rejectionOf(superviseWorker(worker, new Map(), parentDeadline(20)))).reason).toBe(
      failure,
    );
    expect(terminate).toHaveBeenCalledTimes(1);
    expectNoExecutionListeners(worker);
  });

  test("interrupts busy workers, keeps the host responsive, and lets the process exit", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("./fixtures/worker-deadline-process.ts", import.meta.url)),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => child.kill(), 5000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      const results = stdout
        .trim()
        .split("\n")
        .map((line) => {
          const value: unknown = JSON.parse(line);
          return value;
        });
      expect(results).toEqual([
        { result: timeout(100), called: true },
        {
          result: timeout(500),
          called: true,
          responsive: true,
        },
        {
          ok: false,
          error: { kind: "timeout", message: "Execution interrupted by the parent." },
        },
        { ok: true, value: 42 },
      ]);
    } finally {
      clearTimeout(timer);
      child.kill();
    }
  }, 10000);
});

function parentDeadline(timeoutMs: number): WorkerDeadline {
  return {
    timeoutMs,
    expiresAt: performance.now() + timeoutMs,
    interrupt: new Int32Array(new SharedArrayBuffer(4)),
  };
}

function timeout(timeoutMs: number) {
  return {
    ok: false,
    error: { kind: "timeout", message: `Execution exceeded the ${timeoutMs} ms total limit.` },
  } satisfies SandboxResult;
}

function expectNoExecutionListeners(worker: ReturnType<typeof faultWorker>) {
  for (const name of ["message", "messageerror", "exit", "error"]) {
    expect(worker.listenerCount(name)).toBe(0);
  }
}
