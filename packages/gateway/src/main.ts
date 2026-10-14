import { resolve } from "node:path";
import { serve } from "./server.ts";
import { login, logout, type CredentialOptions } from "./auth/login.ts";
import { AuthorizationError } from "./auth/result.ts";
import { GatewayError } from "./errors.ts";

/** Run the CLI command and return its exit status. */
export async function main(
  args: readonly string[],
  options: CredentialOptions = {},
): Promise<number> {
  const command = args.length === 2 ? args[0] : undefined;
  const path = args.length === 2 ? args[1] : args[0];
  if (
    path === undefined ||
    (args.length === 1 && (path === "login" || path === "logout")) ||
    (args.length !== 1 && !(args.length === 2 && (command === "login" || command === "logout")))
  ) {
    console.error("Usage: cmg <configuration.json>");

    return 1;
  }

  try {
    if (command === "login") {
      // The stack keeps listeners installed across await login, then removes them on
      // return or throw from this branch. `using` suffices because removal is synchronous.
      using listeners = new DisposableStack();
      const shutdown = new AbortController();
      const stop = () => shutdown.abort();
      for (const event of ["SIGINT", "SIGTERM"] as const) {
        process.on(event, stop);
        listeners.defer(() => process.off(event, stop));
      }

      const result = await login(resolve(path), { ...options, signal: shutdown.signal });
      console.error(result.ok ? "Upstream authorization saved." : result.error.message);

      return result.ok ? 0 : 1;
    }

    if (command === "logout") {
      const result = await logout(resolve(path), options);
      console.error(
        result.ok
          ? "Local upstream credentials removed. This does not revoke the upstream grant."
          : result.error.message,
      );

      return result.ok ? 0 : 1;
    }

    await serve(resolve(path), options);
  } catch (error) {
    console.error(
      error instanceof GatewayError || error instanceof AuthorizationError
        ? error.message
        : "CMG server failed. Private diagnostics were not displayed.",
    );

    return 1;
  }

  return 0;
}
