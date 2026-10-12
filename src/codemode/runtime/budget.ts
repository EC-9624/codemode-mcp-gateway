import { type ExecutionLimits } from "./limits";
import { type ToolCallLimit } from "../types";

export type ToolCallLimits = Pick<ExecutionLimits, "maxToolCalls" | "maxConcurrentToolCalls">;

/** Each boundary owns its budget; only outstanding slots are reusable. */
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

      if (pending >= limits.maxConcurrentToolCalls) {
        return {
          kind: "limit",
          resource: "concurrent-tool-calls",
          maximum: limits.maxConcurrentToolCalls,
          message: `Execution exceeded the ${limits.maxConcurrentToolCalls} concurrent tool-call limit.`,
        };
      }

      total++;
      pending++;

      return undefined;
    },
    release() {
      pending--;
    },
  };
}
