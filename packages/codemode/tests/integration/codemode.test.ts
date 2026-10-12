import { describe, expect, test } from "bun:test";
import {
  CodemodeSandbox,
  ToolResult,
  type ExecuteOptions,
  type SandboxOptions,
} from "@cmg/codemode";
import { executionErrorOf } from "../support/execution-error";

describe("CodemodeSandbox", () => {
  test("snapshots tool bindings at construction", async () => {
    const tools = { read: () => ToolResult.success("original") };
    const sandbox = new CodemodeSandbox({ tools });
    tools.read = () => ToolResult.success("replacement");

    const report = await sandbox.execute("return await tools.read();");

    expect(report.result).toEqual({ ok: true, value: "original" });
  });

  test("snapshots configuration at construction", async () => {
    const options = { maxSourceBytes: 1 };
    const sandbox = new CodemodeSandbox(options);
    options.maxSourceBytes = 100;

    const report = await sandbox.execute("return 42;");

    expect(report).toEqual({
      result: {
        ok: false,
        error: {
          kind: "limit",
          resource: "source",
          maximum: 1,
          message: "Source exceeds the 1 byte limit.",
        },
      },
      calls: [],
    });
  });

  test("ignores per-request limit overrides from JavaScript callers", async () => {
    const sandbox = new CodemodeSandbox({
      tools: { read: () => ToolResult.success(42) },
      maxToolCalls: 1,
    });

    const code = "await tools.read(); return await tools.read();";

    const options: ExecuteOptions = {};
    Object.assign(options, { maxToolCalls: 2 });

    const attempted = await sandbox.execute(code, options);
    const subsequent = await sandbox.execute(code);

    for (const report of [attempted, subsequent]) {
      expect(report.result).toEqual({
        ok: false,
        error: {
          kind: "limit",
          resource: "tool-calls",
          maximum: 1,
          message: "Execution exceeded the 1 tool-call limit.",
        },
      });
      expect(report.calls).toHaveLength(1);
    }
  });

  test("uses built-in defaults for explicitly undefined constructor settings", async () => {
    const options: SandboxOptions = {
      tools: { read: () => ToolResult.success(42) },
    };

    // Strict TypeScript rejects this literal; JavaScript and non-strict callers can still send it.
    Object.assign(options, { maxToolCalls: undefined });

    const sandbox = new CodemodeSandbox(options);
    const report = await sandbox.execute("await tools.read(); return await tools.read();");

    expect(report.result).toEqual({ ok: true, value: 42 });
    expect(report.calls).toHaveLength(2);
  });

  test("starts each execution with fresh guest state, call IDs, and budgets", async () => {
    const sandbox = new CodemodeSandbox({
      tools: { read: () => ToolResult.success(42) },
      maxToolCalls: 1,
    });

    const code = `
      const previous = [typeof count, typeof Array.prototype.marker];
      globalThis.count = 1;
      Array.prototype.marker = 1;
      await tools.read();
      return previous;
    `;

    const first = await sandbox.execute(code);
    const second = await sandbox.execute(code);

    for (const report of [first, second]) {
      expect(report).toEqual({
        result: { ok: true, value: ["undefined", "undefined"] },
        calls: [{ callId: 1, name: "read", status: "completed", result: { ok: true, json: "42" } }],
      });
    }
  });

  test.each(["registry", "binding"] as const)(
    "preserves constructor %s failures in host-only diagnostics with no calls",
    async (phase) => {
      const cause = new Error("Private registry failure");

      const options: SandboxOptions =
        phase === "registry"
          ? {
              get tools(): never {
                throw cause;
              },
            }
          : {
              tools: {
                get read(): never {
                  throw cause;
                },
              },
            };

      const failure = await executionErrorOf(
        Promise.resolve().then(() => new CodemodeSandbox(options)),
      );

      expect(failure.cause).toBe(cause);
      expect(failure.calls).toEqual([]);
    },
  );

  test("reads configuration and tool bindings only during construction", async () => {
    let limitReads = 0;
    let toolReads = 0;

    const sandbox = new CodemodeSandbox({
      get maxToolCalls() {
        limitReads++;
        if (limitReads > 1) throw new Error("Configuration read after construction");

        return 1;
      },
      tools: {
        get read() {
          toolReads++;
          if (toolReads > 1) throw new Error("Binding read after construction");

          return () => ToolResult.success(42);
        },
      },
    });

    expect(limitReads).toBe(1);
    expect(toolReads).toBe(1);

    const first = await sandbox.execute("return await tools.read();");
    const second = await sandbox.execute("return await tools.read();");

    expect(first.result).toEqual({ ok: true, value: 42 });
    expect(second.result).toEqual({ ok: true, value: 42 });
    expect(limitReads).toBe(1);
    expect(toolReads).toBe(1);
  });

  test("cancelling one concurrent execution leaves the other running", async () => {
    const cancelStarted = Promise.withResolvers<void>();
    const keepStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const signals = new Map<unknown, AbortSignal>();
    using cleanup = new DisposableStack();
    cleanup.defer(() => release.resolve());

    const sandbox = new CodemodeSandbox({
      tools: {
        wait: async (args, { signal }) => {
          signals.set(args, signal);
          if (args === "cancel") cancelStarted.resolve();

          if (args === "keep") keepStarted.resolve();

          await release.promise;

          return ToolResult.success(args);
        },
      },
      maxToolCalls: 1,
      timeoutMs: 5_000,
    });

    const controller = new AbortController();

    const cancelled = sandbox.execute('return await tools.wait("cancel");', {
      signal: controller.signal,
    });

    const kept = sandbox.execute('return await tools.wait("keep");');

    await Promise.all([cancelStarted.promise, keepStarted.promise]);
    controller.abort();
    const cancelledReport = await cancelled;
    expect(cancelledReport.result).toEqual({
      ok: false,
      error: { kind: "cancelled", message: "Execution cancelled." },
    });
    expect(signals.get("cancel")?.aborted).toBe(true);
    expect(signals.get("keep")?.aborted).toBe(false);

    release.resolve();
    expect((await kept).result).toEqual({ ok: true, value: "keep" });
  });
});
