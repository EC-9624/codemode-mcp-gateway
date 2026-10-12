/** Assert rejection and wrap its original reason to avoid assimilating thenables. */
export async function rejectionOf(operation: Promise<unknown>): Promise<{ reason: unknown }> {
  try {
    await operation;
  } catch (reason) {
    return { reason };
  }

  throw new Error("Expected the operation to reject, but it resolved.");
}
