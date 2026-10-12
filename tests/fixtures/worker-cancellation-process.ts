import { execute, ToolResult } from "../../src/codemode";
import { faultWorker, interruptFlag, superviseWorker } from "../support/workers";

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
      await execute(
        "tools.started(); while (true) {}",
        {
          started: () => {
            computation.abort();

            return ToolResult.success();
          },
        },
        { signal: computation.signal, timeoutMs: 10000 },
      )
    ).result,
  ),
);

console.log(
  JSON.stringify(
    (await execute("return 42;", {}, { signal: new AbortController().signal })).result,
  ),
);
