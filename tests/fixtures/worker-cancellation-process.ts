import { execute, ToolResult } from "../../src/sandbox";
import { superviseWorker } from "../../src/worker-execution";
import { faultWorker } from "../support/workers";

// An outer process timeout bounds regressions that would otherwise hang bun:test.
const startup = new AbortController();
console.log(
  JSON.stringify(
    (
      await superviseWorker(
        faultWorker("startup-loop", ["read"]),
        new Map([
          [
            "read",
            () => {
              startup.abort();

              return ToolResult.success();
            },
          ],
        ]),
        { signal: startup.signal, interrupt: new Int32Array(new SharedArrayBuffer(4)) },
      )
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
