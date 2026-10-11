import { execute, ToolResult } from "../../src/sandbox";
import { superviseWorker, type WorkerControl } from "../../src/worker-execution";
import { faultWorker, toolWorker } from "../support/workers";

// Run potentially stuck workers in a child process so a broken interrupt cannot hang bun:test.
const startupDeadline = {
  deadline: { timeoutMs: 100, expiresAt: performance.now() + 100 },
  interrupt: new Int32Array(new SharedArrayBuffer(4)),
} satisfies WorkerControl;

let startupCalled = false;
console.log(
  JSON.stringify({
    result: (
      await superviseWorker(
        faultWorker("startup-loop", ["read"]),
        new Map([
          [
            "read",
            () => {
              startupCalled = true;

              return ToolResult.success();
            },
          ],
        ]),
        startupDeadline,
      )
    ).result,
    called: startupCalled,
  }),
);

let ticks = 0;
const timer = setInterval(() => ticks++, 10);
let startedTicks = 0;
let called = false;
try {
  const { result } = await execute(
    "tools.started(); while (true) {}",
    {
      started: () => {
        called = true;
        startedTicks = ticks;

        return ToolResult.success();
      },
    },
    { timeoutMs: 10000, totalTimeoutMs: 500 },
  );

  console.log(
    JSON.stringify({
      result,
      called,
      responsive: ticks > startedTicks,
    }),
  );
} finally {
  clearInterval(timer);
}

// No supervisor deadline here: the shared flag alone must interrupt running QuickJS.
const interrupt = new Int32Array(new SharedArrayBuffer(4));
const worker = toolWorker("tools.read(); while (true) {}", 10000, interrupt.buffer);
console.log(
  JSON.stringify(
    (
      await superviseWorker(
        worker,
        new Map([
          [
            "read",
            () => {
              Atomics.store(interrupt, 0, 1);

              return ToolResult.success();
            },
          ],
        ]),
      )
    ).result,
  ),
);

// An uncleared parent timer would keep this child alive after successful completion.
console.log(
  JSON.stringify((await execute("return 42;", {}, { totalTimeoutMs: 2 ** 31 - 1 })).result),
);
