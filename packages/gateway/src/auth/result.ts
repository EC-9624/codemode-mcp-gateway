export type AuthFailure = {
  kind:
    | "required"
    | "denied"
    | "unavailable"
    | "storage"
    | "invalid"
    | "busy"
    | "unsupported"
    | "cancelled";
  message: string;
  /** Private diagnostics; never render arbitrary causes in CLI or guest responses. */
  cause?: unknown;
};

export type AuthResult<T> = { ok: true; value: T } | { ok: false; error: AuthFailure };

export const AuthResult = {
  success<T>(value: T): AuthResult<T> {
    return { ok: true, value };
  },
  failure(kind: AuthFailure["kind"], message: string, cause?: unknown): AuthResult<never> {
    return { ok: false, error: { kind, message, ...(cause === undefined ? {} : { cause }) } };
  },
};

/** Adapts explicit failures only at SDK/CLI boundaries requiring thrown errors. */
export class AuthorizationError extends Error {
  /** Only for failures before a token exchange could have rotated the stored grant. */
  static beforeExchange(failure: AuthFailure, version?: string): AuthorizationError {
    const retry =
      failure.kind === "unavailable" || failure.kind === "storage" || failure.kind === "busy";

    return new AuthorizationError(failure, version, retry ? "retry" : "login");
  }

  constructor(
    readonly failure: AuthFailure,
    readonly credentialVersion?: string,
    readonly recovery: "login" | "retry" | "reopen" = "login",
  ) {
    super(failure.message, { cause: failure.cause });
    this.name = "AuthorizationError";
  }
}
