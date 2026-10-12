import { SandboxExecutionError } from "@cmg/codemode";
import { rejectionOf } from "./rejection";

export async function executionErrorOf(
  operation: Promise<unknown>,
): Promise<SandboxExecutionError> {
  const { reason } = await rejectionOf(operation);
  if (!(reason instanceof SandboxExecutionError)) {
    throw new Error("Expected a SandboxExecutionError rejection.", { cause: reason });
  }

  return reason;
}
