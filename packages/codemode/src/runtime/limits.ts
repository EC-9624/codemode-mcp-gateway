import { SandboxLimits } from "../limits.js";

/** Longer delays overflow host timers, which then fire immediately; sizes and counts share the range. */
export const MAX_LIMIT = SandboxLimits.totalTimeoutMs.maximum;

export const MAX_STACK_SIZE_BYTES = SandboxLimits.maxStackSizeBytes.maximum;

export type ExecutionLimits = {
  readonly timeoutMs: number;
  readonly memoryLimitBytes: number;
  readonly maxStackSizeBytes: number;
  readonly maxSourceBytes: number;
  readonly maxOutputBytes: number;
  readonly maxToolCalls: number;
  readonly maxConcurrentToolCalls: number;
};

export const DEFAULT_LIMITS: ExecutionLimits = {
  timeoutMs: SandboxLimits.timeoutMs.default,
  memoryLimitBytes: SandboxLimits.memoryLimitBytes.default,
  maxStackSizeBytes: SandboxLimits.maxStackSizeBytes.default,
  maxSourceBytes: SandboxLimits.maxSourceBytes.default,
  maxOutputBytes: SandboxLimits.maxOutputBytes.default,
  maxToolCalls: SandboxLimits.maxToolCalls.default,
  maxConcurrentToolCalls: SandboxLimits.maxConcurrentToolCalls.default,
};

const MAXIMUM_LIMITS: ExecutionLimits = {
  timeoutMs: SandboxLimits.timeoutMs.maximum,
  memoryLimitBytes: SandboxLimits.memoryLimitBytes.maximum,
  maxStackSizeBytes: SandboxLimits.maxStackSizeBytes.maximum,
  maxSourceBytes: SandboxLimits.maxSourceBytes.maximum,
  maxOutputBytes: SandboxLimits.maxOutputBytes.maximum,
  maxToolCalls: SandboxLimits.maxToolCalls.maximum,
  maxConcurrentToolCalls: SandboxLimits.maxConcurrentToolCalls.maximum,
};

export function isPositiveInt(value: unknown, maximum = MAX_LIMIT): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= maximum;
}

/** Returns the first field outside its range, in declaration order. */
export function findInvalidLimit(limits: Readonly<Record<string, unknown>>) {
  for (const [name, maximum] of Object.entries(MAXIMUM_LIMITS)) {
    if (!isPositiveInt(limits[name], maximum)) return { name, maximum };
  }

  return undefined;
}
