import { z } from "zod";
import { GatewayError } from "./errors.ts";
import { ServerStatus } from "./upstream.ts";

const status = z.object({
  service: z.object({
    ready: z.literal(true),
    pid: z.number().int().positive(),
    instanceId: z.uuid(),
    uptimeMs: z.number().nonnegative(),
  }),
  sessions: z.number().int().nonnegative(),
  upstreams: z.array(ServerStatus),
});

export type HttpStatus = z.infer<typeof status>;

/** Query only the configured loopback endpoint; never follow a credential-bearing redirect. */
export async function httpStatus(
  port: number,
  token: string,
  signal?: AbortSignal,
): Promise<HttpStatus> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/status`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(2_000),
        ...(signal === undefined ? [] : [signal]),
      ]),
    });
  } catch (cause) {
    throw new GatewayError(
      "The local gateway status is unavailable. Verify its configured port and that gw serve --transport http is running; redirects are not followed.",
      { cause },
    );
  }

  if (response.status === 401)
    throw new GatewayError(
      "The local gateway rejected GW_HTTP_TOKEN. Use the same token as the running gateway.",
    );

  if (!response.ok)
    throw new GatewayError(`Local gateway status failed with HTTP ${response.status}.`);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new GatewayError("The service port did not return a valid gateway status.", { cause });
  }

  const parsed = status.safeParse(payload);
  if (!parsed.success)
    throw new GatewayError("The service port did not return a valid gateway status.");

  return parsed.data;
}
