import { CodemodeSandbox, ToolResult } from "@cmg/codemode";
import {
  faultWorker,
  interruptFlag,
  superviseWorker,
  toolWorker,
  type WorkerControl,
} from "../support/workers";

// Run potentially stuck workers in a child process so a broken interrupt cannot hang bun:test.
const startupDeadline = {
  deadline: { timeoutMs: 100, expiresAt: performance.now() + 100 },
  interrupt: interruptFlag(),
} satisfies WorkerControl;

let startupCalled = false;
console.log(
  JSON.stringify({
    result: (
      await superviseWorker(faultWorker("startup-loop", ["read"]), {
        tools: {
          read: () => {
            startupCalled = true;

            return ToolResult.success();
          },
        },
        control: startupDeadline,
      })
    ).result,
    called: startupCalled,
  }),
);

let ticks = 0;
const timer = setInterval(() => ticks++, 10);
let startedTicks = 0;
let called = false;
try {
  const { result } = await new CodemodeSandbox({
    tools: {
      started: () => {
        called = true;
        startedTicks = ticks;

        return ToolResult.success();
      },
    },
    timeoutMs: 10000,
    totalTimeoutMs: 500,
  }).execute("tools.started(); while (true) {}");

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
const interrupt = interruptFlag();
const worker = toolWorker("tools.read(); while (true) {}", 10000, interrupt.buffer);
console.log(
  JSON.stringify(
    (
      await superviseWorker(worker, {
        tools: {
          read: () => {
            Atomics.store(interrupt, 0, 1);

            return ToolResult.success();
          },
        },
      })
    ).result,
  ),
);

// An uncleared parent timer would keep this child alive after successful completion.
console.log(
  JSON.stringify(
    (await new CodemodeSandbox({ totalTimeoutMs: 2 ** 31 - 1 }).execute("return 42;")).result,
  ),
);
