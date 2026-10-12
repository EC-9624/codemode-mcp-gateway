import { type CallOutcome } from "./types.js";

/** Host-only infrastructure failure. The cause preserves setup, transport, or cleanup failures. */
export class SandboxExecutionError extends Error {
  constructor(
    readonly calls: readonly CallOutcome[],
    cause: unknown,
  ) {
    super("Sandbox execution infrastructure failed.", { cause });
    this.name = "SandboxExecutionError";
  }
}
