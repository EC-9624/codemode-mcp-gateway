/** Longer delays overflow host timers, which then fire immediately; sizes and counts share the range. */
export const MAX_LIMIT = 2 ** 31 - 1;

// Leave headroom below the pinned WASM build's 5 MiB stack. Larger guards can
// underflow QuickJS's stack limit rather than increase usable stack space.
export const MAX_STACK_SIZE_BYTES = 4 * 1024 * 1024;

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
  timeoutMs: 1000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxStackSizeBytes: 1024 * 1024,
  maxSourceBytes: 256 * 1024,
  maxOutputBytes: 256 * 1024,
  maxToolCalls: 100,
  maxConcurrentToolCalls: 10,
};

const MAXIMUM_LIMITS: ExecutionLimits = {
  timeoutMs: MAX_LIMIT,
  memoryLimitBytes: MAX_LIMIT,
  maxStackSizeBytes: MAX_STACK_SIZE_BYTES,
  maxSourceBytes: MAX_LIMIT,
  maxOutputBytes: MAX_LIMIT,
  maxToolCalls: MAX_LIMIT,
  maxConcurrentToolCalls: MAX_LIMIT,
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
