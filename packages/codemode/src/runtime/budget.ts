import { type ExecutionLimits } from "./limits.ts";
import { type ToolCallLimit } from "../types.ts";

export type ToolCallLimits = Pick<ExecutionLimits, "maxToolCalls" | "maxConcurrentToolCalls">;

/** Total admission counts queued calls too; only active slots are reusable. */
export function createToolCallBudget(limits: ToolCallLimits) {
  let total = 0;
  let pending = 0;

  return {
    admit(): ToolCallLimit | undefined {
      if (total >= limits.maxToolCalls) {
        return {
          kind: "limit",
          resource: "tool-calls",
          maximum: limits.maxToolCalls,
          message: `Execution exceeded the ${limits.maxToolCalls} tool-call limit.`,
        };
      }

      total++;

      return undefined;
    },
    start(): ToolCallLimit | undefined {
      if (pending >= limits.maxConcurrentToolCalls) {
        return {
          kind: "limit",
          resource: "concurrent-tool-calls",
          maximum: limits.maxConcurrentToolCalls,
          message: `Execution exceeded the ${limits.maxConcurrentToolCalls} concurrent tool-call limit.`,
        };
      }

      pending++;

      return undefined;
    },
    release() {
      pending--;
    },
  };
}
