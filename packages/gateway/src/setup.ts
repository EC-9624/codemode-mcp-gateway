import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readConfiguration } from "./config.ts";
import { GatewayError } from "./errors.ts";
import { prepareHttpToken } from "./http-token.ts";

/** Prepare only gateway-owned files. Upstream definitions, clients, and supervision stay user-managed. */
export async function setup(path: string): Promise<void> {
  // Validate/provision authentication before creating a starter configuration.
  const token = await prepareHttpToken();
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  } catch (cause) {
    throw new GatewayError("Could not create the gateway configuration directory.", { cause });
  }

  let created = false;
  try {
    await writeFile(path, JSON.stringify({ mcp: { servers: {} } }, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    created = true;
  } catch (cause) {
    if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "EEXIST")
      throw new GatewayError(
        "Could not create the gateway configuration. Existing files were not replaced.",
        { cause },
      );
  }

  let info;
  try {
    info = await stat(path);
  } catch (cause) {
    throw new GatewayError(
      "Could not inspect the gateway configuration. Existing paths were not replaced.",
      { cause },
    );
  }

  if (!info.isFile())
    throw new GatewayError(
      "The configuration path must refer to a regular file. Existing paths were not replaced.",
    );

  console.log(
    `${created ? "Created starter configuration" : "Kept existing configuration"}: ${path}`,
  );
  console.log(
    token.source === "environment"
      ? "HTTP authentication: using GW_HTTP_TOKEN (not saved)."
      : `${token.created ? "Created" : "Kept"} private HTTP token: ${token.path}`,
  );
  try {
    const config = await readConfiguration(path);
    console.log(
      "Configuration is valid; upstream connectivity and authorization have not been checked.",
    );
    console.log(`Client endpoint: http://127.0.0.1:${config.service.port}/mcp`);
  } catch (cause) {
    if (!(cause instanceof GatewayError)) throw cause;

    console.log("Configuration is not ready. Add your upstream MCP servers, then run gw check.");
  }

  console.log(
    "Configure MCP clients yourself with Authorization: Bearer <token>. Run gw token to reveal the effective token explicitly.",
  );
  console.log(
    "Run gw login --server <name> for an OAuth upstream, then gw serve to start the foreground gateway.",
  );
  console.log("For a nondefault configuration, pass its --config path to check, login, and serve.");
  console.log(
    "No clients, upstream credentials, or OS services were configured. No process was started.",
  );
}
