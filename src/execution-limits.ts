export type ExecutionLimits = {
  readonly memoryLimitBytes: number;
  readonly maxStackSizeBytes: number;
  readonly maxSourceBytes: number;
  readonly maxOutputBytes: number;
  readonly maxToolCalls: number;
  readonly maxConcurrentToolCalls: number;
};

export const DEFAULT_LIMITS: ExecutionLimits = {
  memoryLimitBytes: 64 * 1024 * 1024,
  maxStackSizeBytes: 1024 * 1024,
  maxSourceBytes: 256 * 1024,
  maxOutputBytes: 256 * 1024,
  maxToolCalls: 100,
  maxConcurrentToolCalls: 10,
};

/** Keep byte counts within the positive signed 32-bit range used by this API. */
export const MAX_LIMIT_BYTES = 2 ** 31 - 1;
export const MAX_CALL_COUNT = 2 ** 31 - 1;

// Leave headroom below the pinned WASM build's 5 MiB stack. Larger guards can
// underflow QuickJS's stack limit rather than increase usable stack space.
export const MAX_STACK_SIZE_BYTES = 4 * 1024 * 1024;

export function isByteLimit(value: unknown, maximum = MAX_LIMIT_BYTES): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= maximum;
}

export function isCallCount(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_CALL_COUNT
  );
}
