export type GuestResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { kind: "script" | "timeout"; message: string } };

/** Cancellation and source admission limits are classified by the parent. */
export type SandboxResult =
  | GuestResult
  | { ok: false; error: { kind: "cancelled"; message: string } }
  | { ok: false; error: { kind: "limit"; resource: "source"; maximum: number; message: string } };
