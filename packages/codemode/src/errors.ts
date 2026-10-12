import { type CallOutcome } from "./types.js";

/**
 * Host-only infrastructure failure with the final call observations, including interrupted calls.
 * Host setup/transport/cleanup failures retain their cause; worker failures supply a controlled
 * category instead of transferring private worker exception messages, stacks, or identity.
 */
export class SandboxExecutionError extends Error {
  constructor(
    readonly calls: readonly CallOutcome[],
    cause: unknown,
  ) {
    super("Sandbox execution infrastructure failed.", { cause });
    this.name = "SandboxExecutionError";
  }
}
