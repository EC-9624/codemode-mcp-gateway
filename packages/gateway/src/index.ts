/** Programmatic gateway composition; importing this entry does not start the CLI. */
export { Configuration, resolveHeaders } from "./config.ts";
export { createServer } from "./composition.ts";
export { serve } from "./server.ts";
export { login, logout, type LoginOptions, type CredentialOptions } from "./auth/login.ts";
export { type CredentialStore, Credentials, type OAuthConnection } from "./auth/credentials.ts";
export { AuthorizationError, type AuthResult, type AuthFailure } from "./auth/result.ts";
