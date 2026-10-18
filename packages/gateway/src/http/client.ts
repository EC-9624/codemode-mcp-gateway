import { GatewayError } from "../errors.ts";
import { ToolList } from "../tool-list.ts";
import { HttpStatus } from "./protocol.ts";

/** Query only the configured loopback endpoint; never follow a credential-bearing redirect. */
export async function httpStatus(
  port: number,
  token: string,
  signal?: AbortSignal,
): Promise<HttpStatus> {
  const parsed = HttpStatus.safeParse(await readHttpJson(port, token, "status", signal));
  if (!parsed.success)
    throw new GatewayError("The service port did not return a valid gateway status.");

  return parsed.data;
}

export async function httpTools(
  port: number,
  token: string,
  signal?: AbortSignal,
): Promise<ToolList> {
  const parsed = ToolList.safeParse(await readHttpJson(port, token, "tools", signal));
  if (!parsed.success)
    throw new GatewayError("The service port did not return a valid gateway tool list.");

  return parsed.data;
}

/** Read only loopback management data; never follow a credential-bearing redirect. */
async function readHttpJson(
  port: number,
  token: string,
  resource: "status" | "tools",
  signal?: AbortSignal,
): Promise<unknown> {
  const label = resource === "tools" ? "tool list" : "status";
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/${resource}`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(2_000),
        ...(signal === undefined ? [] : [signal]),
      ]),
    });
  } catch (cause) {
    throw new GatewayError(
      `The local gateway ${label} is unavailable. Verify its configured port and that gw serve --transport http is running; redirects are not followed.`,
      { cause },
    );
  }

  if (response.status === 401)
    throw new GatewayError(
      "The local gateway rejected the gateway credential. Use the same token as the running gateway.",
    );

  if (resource === "tools" && response.status === 404)
    throw new GatewayError(
      "The service port returned HTTP 404 for tool listing. Restart an older gateway with an updated gw executable.",
    );

  if (!response.ok)
    throw new GatewayError(`Local gateway ${label} failed with HTTP ${response.status}.`);

  try {
    return await response.json();
  } catch (cause) {
    throw new GatewayError(`The service port did not return a valid gateway ${label}.`, { cause });
  }
}
