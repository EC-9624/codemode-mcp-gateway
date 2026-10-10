import { describe, expect, spyOn, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { execute } from "../src/sandbox";
import { executeInWorker, executeWorker } from "../src/worker-execution";
import { WorkerRequest, WorkerResponse } from "../src/worker-protocol";

describe("worker protocol", () => {
  test("validates execution requests", () => {
    expect(WorkerRequest.is({ type: "execute", code: "return 42;" })).toBe(true);
    for (const value of [null, undefined, 42, [], {}, { type: "execute", code: 42 }]) {
      expect(WorkerRequest.is(value)).toBe(false);
    }
  });

  test("validates completion and infrastructure failure envelopes", () => {
    for (const value of [
      { type: "completed", result: { ok: true, value: null } },
      { type: "completed", result: { ok: false, error: { kind: "script", message: "failed" } } },
      { type: "completed", result: { ok: false, error: { kind: "timeout", message: "expired" } } },
      { type: "failed", reason: "execution" },
      { type: "failed", reason: "request" },
    ]) {
      expect(WorkerResponse.is(value)).toBe(true);
    }
    for (const value of [
      null,
      undefined,
      {},
      { type: "other" },
      { type: "failed", reason: "other" },
      { type: "completed", result: null },
      { type: "completed", result: { ok: true } },
      { type: "completed", result: { ok: "true", value: 42 } },
      { type: "completed", result: { ok: false, error: null } },
      { type: "completed", result: { ok: false, error: { kind: "other", message: "failed" } } },
      { type: "completed", result: { ok: false, error: { kind: "script", message: 42 } } },
    ]) {
      expect(WorkerResponse.is(value)).toBe(false);
    }
  });
});

describe("worker execution", () => {
  test("preserves sandbox values, promises, JSON conversion, and errors", async () => {
    for (const code of [
      "return 1 + 2;",
      'return { name: "mcm", values: [1, true, null] };',
      "return null;",
      "return false;",
      "return 0;",
      'return "";',
      "return undefined;",
      "const value = 3;",
      "return { omitted: undefined, values: [undefined, NaN, Infinity] };",
      'JSON.stringify = () => "broken"; return { value: 3 };',
      "return Promise.resolve(3);",
      "return { then(resolve) { resolve(3); } };",
      'throw new Error("Something failed");',
      'throw "Something failed";',
      "throw null;",
      "throw Promise.resolve(3);",
      "throw new Promise(() => {});",
      'throw Promise.reject(new Error("inner"));',
      "return (;",
      "return 1n;",
      "const value = {}; value.self = value; return value;",
      "return () => 3;",
      "return new Promise(() => {});",
      "return [typeof process, typeof Bun, typeof require, typeof fetch];",
      "return Object.keys(tools);",
    ]) {
      expect(await executeInWorker(code)).toEqual(await execute(code));
    }
  });

  test("retains the private prelude boundary", async () => {
    expect(
      await executeInWorker("return [typeof hostTools, typeof run, tools === globalThis.tools];"),
    ).toEqual({ ok: true, value: ["undefined", "undefined", true] });
    const escaped = await executeInWorker("}); globalThis.escaped = true; (async () => {");
    expect(escaped.ok).toBe(false);
    if (!escaped.ok) expect(escaped.error.kind).toBe("script");
  });

  test("creates fresh guest state and preserves concurrent result routing", async () => {
    expect(
      await executeInWorker("globalThis.marker = 3; Array.prototype.marker = 3; return marker;"),
    ).toEqual({ ok: true, value: 3 });
    expect(await executeInWorker("return [typeof marker, typeof Array.prototype.marker];")).toEqual(
      {
        ok: true,
        value: ["undefined", "undefined"],
      },
    );
    expect(
      await Promise.all([1, 2, 3, 4].map((value) => executeInWorker(`return ${value};`))),
    ).toEqual([1, 2, 3, 4].map((value) => ({ ok: true, value })));
  });

  test("keeps main-thread timers running during guest computation, not just worker startup", async () => {
    const ticks: number[] = [];
    const timer = setInterval(() => ticks.push(Date.now()), 10);
    try {
      const result = await executeInWorker(`
        const started = Date.now();
        while (Date.now() - started < 400) {}
        return { started, ended: Date.now() };
      `);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const value = result.value;
      if (
        typeof value !== "object" ||
        value === null ||
        !("started" in value) ||
        typeof value.started !== "number" ||
        !("ended" in value) ||
        typeof value.ended !== "number"
      )
        throw new Error("Expected numeric guest computation timestamps.");
      const started = value.started;
      const ended = value.ended;
      expect(ticks.some((tick) => tick > started + 50 && tick < ended - 50)).toBe(true);
    } finally {
      clearInterval(timer);
    }
  });

  test("interrupts infinite guest computation and recovers", async () => {
    expect(await executeInWorker("while (true) {} ")).toEqual({
      ok: false,
      error: { kind: "timeout", message: "Execution exceeded the 1-second limit." },
    });
    expect(await executeInWorker("return 42;")).toEqual({ ok: true, value: 42 });
  });

  test("rejects invalid requests at the actual worker boundary", async () => {
    const worker = new Worker(new URL("../src/worker-entry.ts", import.meta.url).href, {
      ref: true,
    });
    try {
      const response = Promise.withResolvers<unknown>();
      worker.addEventListener("message", (event) => response.resolve(event.data), { once: true });
      worker.postMessage({ type: "execute", code: 42 });
      expect(await response.promise).toEqual({ type: "failed", reason: "request" });
    } finally {
      worker.terminate();
    }
  });

  test("rejects startup failures without returning a script error", async () => {
    const worker = new Worker(new URL("./fixtures/missing-worker.ts", import.meta.url).href, {
      ref: true,
    });
    const failure: unknown = await executeWorker(worker, "return 42;").catch(
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(Error);
    if (failure instanceof Error) expect(failure.message).toContain("Sandbox worker failed.");
    expect(await executeInWorker("return 42;")).toEqual({ ok: true, value: 42 });
  });

  test("rejects protocol, reported infrastructure, crash, and premature-close failures", async () => {
    for (const [scenario, message] of [
      ["invalid-response", "invalid response"],
      ["execution-failure", "execution failed"],
      ["request-failure", "rejected the execution request"],
      ["crash", "Sandbox worker failed."],
      ["close", "closed before completion"],
    ] as const) {
      const worker = new Worker(new URL("./fixtures/worker-fault.ts", import.meta.url).href, {
        ref: true,
      });
      using remove = spyOn(worker, "removeEventListener");
      using terminate = spyOn(worker, "terminate");
      const failure: unknown = await executeWorker(worker, scenario).catch(
        (cause: unknown) => cause,
      );
      expect(failure).toBeInstanceOf(Error);
      if (failure instanceof Error) {
        expect(failure.message).toContain(message);
        expect(failure.message).not.toContain("Private fixture failure details");
      }
      expect(remove).toHaveBeenCalledTimes(4);
      expect(terminate).toHaveBeenCalledTimes(1);
    }
    expect(await executeInWorker("return 42;")).toEqual({ ok: true, value: 42 });
  });

  test("settles once and cleans up listeners and the worker", async () => {
    const worker = new Worker(new URL("./fixtures/worker-fault.ts", import.meta.url).href, {
      ref: true,
    });
    using add = spyOn(worker, "addEventListener");
    using remove = spyOn(worker, "removeEventListener");
    using terminate = spyOn(worker, "terminate");
    expect(await executeWorker(worker, "duplicate")).toEqual({ ok: true, value: 42 });
    expect(remove.mock.calls).toEqual(add.mock.calls.toReversed());
    expect(remove).toHaveBeenCalledTimes(4);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  test("keeps actual worker infrastructure exception details out of the response", async () => {
    const worker = new Worker(new URL("../src/worker-entry.ts", import.meta.url).href, {
      ref: true,
      preload: [fileURLToPath(new URL("./fixtures/worker-parser-fault.ts", import.meta.url))],
    });
    const failure: unknown = await executeWorker(worker, "return 42;").catch(
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(Error);
    if (failure instanceof Error) {
      expect(failure.message).toContain("Sandbox worker execution failed.");
      expect(failure.message).not.toContain("Private parser infrastructure details");
    }
    expect(await executeInWorker("return 42;")).toEqual({ ok: true, value: 42 });
  });

  test("cleans up after response deserialization errors", async () => {
    const worker = new Worker(new URL("./fixtures/worker-fault.ts", import.meta.url).href, {
      ref: true,
    });
    using remove = spyOn(worker, "removeEventListener");
    using terminate = spyOn(worker, "terminate");
    const completion = executeWorker(worker, "idle");
    // A real structured-clone failure on receipt is not reliably constructible.
    worker.dispatchEvent(new MessageEvent("messageerror"));
    const failure: unknown = await completion.catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    if (failure instanceof Error) expect(failure.message).toContain("could not be deserialized");
    expect(remove).toHaveBeenCalledTimes(4);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  test("cleans up if sending the execution request throws", async () => {
    const worker = new Worker(new URL("./fixtures/worker-fault.ts", import.meta.url).href, {
      ref: true,
    });
    const failure = new Error("Request transport failed");
    using post = spyOn(worker, "postMessage").mockImplementation(() => {
      throw failure;
    });
    using remove = spyOn(worker, "removeEventListener");
    using terminate = spyOn(worker, "terminate");
    expect(await executeWorker(worker, "idle").catch((cause: unknown) => cause)).toBe(failure);
    expect(post).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(4);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  test("unwinds partial listener setup before terminating the worker", async () => {
    const worker = new Worker(new URL("./fixtures/worker-fault.ts", import.meta.url).href, {
      ref: true,
    });
    const failure = new Error("Listener setup failed");
    const addListener = worker.addEventListener.bind(worker);
    using add = spyOn(worker, "addEventListener").mockImplementation(
      (...args: Parameters<Worker["addEventListener"]>) => {
        if (args[0] === "error") throw failure;
        addListener(...args);
      },
    );
    using remove = spyOn(worker, "removeEventListener");
    using terminate = spyOn(worker, "terminate");
    expect(await executeWorker(worker, "idle").catch((cause: unknown) => cause)).toBe(failure);
    expect(add).toHaveBeenCalledTimes(2);
    expect(remove.mock.calls).toEqual(add.mock.calls.toReversed());
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(
      remove.mock.invocationCallOrder.every((order) =>
        terminate.mock.invocationCallOrder.every((termination) => order < termination),
      ),
    ).toBe(true);
  });

  test("allows a process to exit after successful and failed guest executions", async () => {
    const child = Bun.spawn(
      [process.execPath, fileURLToPath(new URL("./fixtures/worker-process.ts", import.meta.url))],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timer = setTimeout(() => child.kill(), 10000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(
        stdout
          .trim()
          .split("\n")
          .map((line) => {
            const value: unknown = JSON.parse(line);
            return value;
          }),
      ).toEqual([
        { ok: true, value: 42 },
        { ok: false, error: { kind: "script", message: "guest failure" } },
      ]);
    } finally {
      clearTimeout(timer);
      child.kill();
    }
  }, 15000);
});
