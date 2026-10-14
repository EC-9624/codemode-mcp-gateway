import { describe, expect, test } from "bun:test";
import { ToolResult } from "@cmg/codemode";
import { DEFAULT_LIMITS } from "../src/runtime/limits.ts";
import { executeEngine } from "../src/runtime/engine.ts";
import { expectDisposedExecution, type ExecutionResources } from "./support/disposal.ts";
import { installLocalToolBridge } from "./support/local-tools.ts";
import { interruptFlag } from "./support/workers.ts";

// The parent also enforces public limits. A worker-local probe is needed to prove
// the guest bridge itself stops dispatch and disposes resources without parent enforcement.
describe("worker-side admission ownership", () => {
  test.each([
    [
      "total",
      { maxToolCalls: 2, maxConcurrentToolCalls: 10 },
      "tool-calls",
      "Execution exceeded the 2 tool-call limit.",
    ],
    [
      "concurrent",
      { maxToolCalls: 10, maxConcurrentToolCalls: 2 },
      "concurrent-tool-calls",
      "Execution exceeded the 2 concurrent tool-call limit.",
    ],
  ] as const)(
    "stops at the %s limit despite guest catch and disposes resources",
    async (_name, limits, resource, message) => {
      const resources: ExecutionResources[] = [];
      const late = Promise.withResolvers<ToolResult>();
      using cleanup = new DisposableStack();
      cleanup.defer(() => late.resolve(ToolResult.success()));
      let calls = 0;

      const result = await executeEngine(
        "for (let i = 0; i < 100000; i++) { try { tools.read(); } catch {} } while (true) {}",
        { ...DEFAULT_LIMITS, timeoutMs: 1000 },
        (vm, scope) => {
          resources.push({ vm, scope });

          return installLocalToolBridge(
            vm,
            {
              read: () => {
                calls++;

                return late.promise;
              },
            },
            scope,
            limits,
          );
        },
        interruptFlag(),
      );

      expect(result).toEqual({
        ok: false,
        error: { kind: "limit", resource, maximum: 2, message },
      });
      expect(calls).toBe(2);
      expectDisposedExecution(resources);
    },
  );
});
