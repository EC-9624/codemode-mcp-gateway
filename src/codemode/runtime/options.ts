import {
  DEFAULT_LIMITS,
  findInvalidLimit,
  isPositiveInt,
  MAX_LIMIT,
  type ExecutionLimits,
} from "./limits";
import { type ExecuteOptions } from "../types";

/** Validated budgets. The per-execution signal is never a default. */
export type ResolvedOptions = {
  readonly limits: ExecutionLimits;
  readonly totalTimeoutMs: number | undefined;
};

/**
 * Validate every budget before observing cancellation or accessing the tool registry.
 * Merging per field matters: spreading `{ ...defaults, ...options }` would let an explicit
 * undefined replace a sandbox default with the global one.
 */
export function resolveOptions(
  options: ExecuteOptions,
  defaults: ResolvedOptions = { limits: DEFAULT_LIMITS, totalTimeoutMs: undefined },
): ResolvedOptions {
  const fallback = defaults.limits;

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

  const totalTimeoutMs = orDefault(options.totalTimeoutMs, defaults.totalTimeoutMs);
  if (totalTimeoutMs !== undefined && !isPositiveInt(totalTimeoutMs)) {
    throw new RangeError(`totalTimeoutMs must be an integer from 1 to ${MAX_LIMIT}.`);
  }

  return { limits, totalTimeoutMs };
}

/** Unlike `??`, keeps a JavaScript caller's null so validation rejects it. */
function orDefault<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}
