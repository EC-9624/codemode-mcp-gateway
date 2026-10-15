const MAX_LIMIT = 2 ** 31 - 1;

/** Positive-integer resource policy shared by the runtime and application configuration. */
export const SandboxLimits = {
  timeoutMs: { default: 1000, maximum: MAX_LIMIT },
  totalTimeoutMs: { maximum: MAX_LIMIT },
  memoryLimitBytes: { default: 64 * 1024 * 1024, maximum: MAX_LIMIT },
  // Leave headroom below the pinned WASM build's 5 MiB stack: larger guards can underflow.
  maxStackSizeBytes: { default: 1024 * 1024, maximum: 4 * 1024 * 1024 },
  maxSourceBytes: { default: 256 * 1024, maximum: MAX_LIMIT },
  maxOutputBytes: { default: 256 * 1024, maximum: MAX_LIMIT },
  maxToolCalls: { default: 100, maximum: MAX_LIMIT },
  maxConcurrentToolCalls: { default: 10, maximum: MAX_LIMIT },
  maxConcurrentExecutions: { default: 4, maximum: MAX_LIMIT },
} as const;
