import {
  DEFAULT_LIMITS,
  findInvalidLimit,
  isPositiveInt,
  MAX_LIMIT,
  type ExecutionLimits,
} from "./limits.js";
import { type SandboxOptions } from "../types.js";

/** Fixed, validated configuration. Cancellation belongs to each execution. */
export type ResolvedOptions = {
  readonly limits: ExecutionLimits;
  readonly totalTimeoutMs: number | undefined;
};

/** Apply built-in defaults and validate once, before reading tool bindings. */
export function resolveOptions(options: SandboxOptions): ResolvedOptions {
  const fallback = DEFAULT_LIMITS;

  const limits = {
    timeoutMs: orDefault(options.timeoutMs, fallback.timeoutMs),
    memoryLimitBytes: orDefault(options.memoryLimitBytes, fallback.memoryLimitBytes),
    maxStackSizeBytes: orDefault(options.maxStackSizeBytes, fallback.maxStackSizeBytes),
    maxSourceBytes: orDefault(options.maxSourceBytes, fallback.maxSourceBytes),
    maxOutputBytes: orDefault(options.maxOutputBytes, fallback.maxOutputBytes),
    maxToolCalls: orDefault(options.maxToolCalls, fallback.maxToolCalls),
    maxConcurrentToolCalls: orDefault(
      options.maxConcurrentToolCalls,
      fallback.maxConcurrentToolCalls,
    ),
  } satisfies ExecutionLimits;

  const invalid = findInvalidLimit(limits);
  if (invalid !== undefined) {
    throw new RangeError(`${invalid.name} must be an integer from 1 to ${invalid.maximum}.`);
  }

  const totalTimeoutMs = options.totalTimeoutMs;
  if (totalTimeoutMs !== undefined && !isPositiveInt(totalTimeoutMs)) {
    throw new RangeError(`totalTimeoutMs must be an integer from 1 to ${MAX_LIMIT}.`);
  }

  return { limits, totalTimeoutMs };
}

/** Unlike `??`, keeps a JavaScript caller's null so validation rejects it. */
function orDefault<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}
