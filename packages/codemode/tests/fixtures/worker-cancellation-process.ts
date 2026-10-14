import { CodeExecutor, ToolResult } from "@cmg/codemode";
import { faultWorker, interruptFlag, superviseWorker } from "../support/workers.ts";

// An outer process timeout bounds regressions that would otherwise hang bun:test.
const startup = new AbortController();
console.log(
  JSON.stringify(
    (
      await superviseWorker(faultWorker("startup-loop", ["read"]), {
        tools: {
          read: () => {
            startup.abort();

            return ToolResult.success();
          },
        },
        control: { signal: startup.signal, interrupt: interruptFlag() },
      })
    ).result,
  ),
);

const computation = new AbortController();
console.log(
  JSON.stringify(
    (
      await new CodeExecutor({
        tools: {
          started: () => {
            computation.abort();

            return ToolResult.success();
          },
        },
        timeoutMs: 10000,
      }).execute("tools.started(); while (true) {}", { signal: computation.signal })
    ).result,
  ),
);

console.log(
  JSON.stringify(
    (await new CodeExecutor().execute("return 42;", { signal: new AbortController().signal }))
      .result,
  ),
);
