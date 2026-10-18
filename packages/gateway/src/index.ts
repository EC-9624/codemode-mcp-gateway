/** Programmatic gateway composition; importing this entry does not start the CLI. */
export {
  Configuration,
  ServerConfiguration,
  configurationPath,
  resolveHeaders,
  type ConfigurationInput,
} from "./config.ts";
export { Gateway, type GatewayOptions, type ServerStatus } from "./gateway.ts";
export { type ToolList } from "./tool-list.ts";
export { serve } from "./stdio/serve.ts";
export { GatewayHttpServer, type HttpOptions, type HttpListenResult } from "./http/server.ts";
export { login, logout, type LoginOptions } from "./auth/login.ts";
export {
  type CredentialOptions,
  type CredentialStore,
  Credentials,
  type OAuthConnection,
} from "./auth/credentials.ts";
export { fileCredentialStore } from "./auth/file-store.ts";
export { AuthorizationError, type AuthResult, type AuthFailure } from "./auth/result.ts";
