export type SandboxResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { kind: "script" | "timeout"; message: string } };
