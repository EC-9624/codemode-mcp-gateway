export type GuestResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { kind: "script" | "timeout"; message: string } };

/** Cancellation is classified by the parent, never by guest code. */
export type SandboxResult =
  | GuestResult
  | { ok: false; error: { kind: "cancelled"; message: string } };
