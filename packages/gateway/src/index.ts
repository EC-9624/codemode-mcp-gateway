/** Programmatic gateway composition; importing this entry does not start the CLI. */
export {
  Configuration,
  ServerConfiguration,
  configurationPath,
  resolveHeaders,
  type ConfigurationInput,
} from "./config.ts";
export { Gateway, type GatewayOptions, type ServerStatus } from "./gateway.ts";
export { serve } from "./server.ts";
export { GatewayHttpServer, type HttpOptions, type HttpListenResult } from "./http.ts";
export { login, logout, type LoginOptions, type CredentialOptions } from "./auth/login.ts";
export { type CredentialStore, Credentials, type OAuthConnection } from "./auth/credentials.ts";
export { AuthorizationError, type AuthResult, type AuthFailure } from "./auth/result.ts";
