import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readConfiguration } from "../config.ts";
import { GatewayError } from "../errors.ts";
import { prepareHttpToken } from "../http/token.ts";

/** Prepare only gateway-owned files. Upstream definitions, clients, and supervision stay user-managed. */
export async function setup(path: string, transport?: "stdio" | "http"): Promise<void> {
  // Only explicit HTTP setup reads or provisions the gateway credential.
  const token = transport === "http" ? await prepareHttpToken() : undefined;
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
  if (token !== undefined) {
    console.log(
      token.source === "environment"
        ? "HTTP authentication: using GW_HTTP_TOKEN (not saved)."
        : `${token.created ? "Created" : "Kept"} private HTTP token: ${token.path}`,
    );
  }

  const configFlag = `--config '${path.replace(/'/gu, "'\\''")}'`;
  try {
    const config = await readConfiguration(path);
    console.log(
      "Configuration is valid; upstream connectivity and authorization have not been checked.",
    );
    if (transport === "http")
      console.log(`Client endpoint: http://127.0.0.1:${config.service.port}/mcp`);
  } catch (cause) {
    if (!(cause instanceof GatewayError)) throw cause;

    console.log(
      `Configuration is not ready. Add upstreams, then run:\n  gw config check ${configFlag}`,
    );
  }

  console.log("No clients or services changed. No process was started.");
  if (transport === undefined) {
    console.log(`Next: gw setup --transport http ${configFlag}`);
    console.log("For client-owned stdio instead, see gw setup --help.");

    return;
  }

  if (transport === "http") {
    console.log(
      "Client header: Authorization: Bearer <token>. Use gw token show privately to obtain it.",
    );
    console.log(`When configuration is ready: gw serve ${configFlag}`);
  } else {
    console.log(`Client command: gw serve --transport stdio ${configFlag}`);
    console.log("Stdio needs no gateway HTTP token.");
  }

  console.log(`For OAuth upstreams: gw auth login <server> ${configFlag}`);
}
