import { ok, deepEqual, rejects } from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { CodeExecutor, ToolResult, type ExecutionReport } from "@cmg/codemode";

// Installed alone: no MCP dependencies or repository source can satisfy accidental imports.
const installed = fileURLToPath(import.meta.resolve("@cmg/codemode"));
ok(installed.startsWith(fileURLToPath(new URL("./node_modules/", import.meta.url))));
ok(installed.endsWith("/dist/index.js"));
const internal = "@cmg/codemode/runtime/engine";
await rejects(() => import(internal));

const sandbox = new CodeExecutor({ tools: { answer: () => ToolResult.success(42) } });

const report: ExecutionReport = await sandbox.execute(
  "globalThis.saved = 7; return await tools.answer();",
);

deepEqual(report, {
  result: { ok: true, value: 42 },
  calls: [{ callId: 1, name: "answer", status: "completed" }],
});
deepEqual((await sandbox.execute("return typeof saved;")).result, { ok: true, value: "undefined" });
deepEqual((await sandbox.execute('throw "before\\0after";')).result, {
  ok: false,
  error: { kind: "script", message: "before\u0000after" },
});

const started = Promise.withResolvers<void>();
const release = Promise.withResolvers<ToolResult>();
const controller = new AbortController();

const cancellable = new CodeExecutor({
  maxConcurrentExecutions: 1,
  tools: {
    wait: () => {
      started.resolve();

      return release.promise;
    },
  },
});

try {
  const pending = cancellable.execute("return await tools.wait();", { signal: controller.signal });
  await started.promise;
  deepEqual(await cancellable.execute("return 7;"), {
    result: {
      ok: false,
      error: {
        kind: "limit",
        resource: "executions",
        maximum: 1,
        message: "Executor reached the 1 concurrent-execution limit.",
      },
    },
    calls: [],
  });
  controller.abort();
  const cancelled = await pending;

  deepEqual(cancelled.result, {
    ok: false,
    error: { kind: "cancelled", message: "Execution cancelled." },
  });
  deepEqual(cancelled.calls, [
    { callId: 1, name: "wait", status: "interrupted", reason: "cancelled" },
  ]);
} finally {
  release.resolve(ToolResult.success());
}

deepEqual((await cancellable.execute("return 42;")).result, { ok: true, value: 42 });
