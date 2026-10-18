import { type Client } from "@modelcontextprotocol/client";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { responseText } from "./output.ts";

/** Poll only discovery; operation scripts are never retried. */
export async function waitForServer(client: Client, name: string, timeoutMs = 30_000) {
  const signal = AbortSignal.timeout(timeoutMs);

  const status = z.object({
    state: z.enum(["connecting", "connected", "failed", "needs-auth", "disabled"]),
  });

  while (true) {
    signal.throwIfAborted();

    const response = await client.callTool(
      {
        name: "execute",
        arguments: {
          code: `return (await tools.searchTools({ query: "tools", server: ${JSON.stringify(name)} })).servers[0];`,
        },
      },
      { signal },
    );

    if (response.isError) throw new Error("Gateway discovery failed.");

    const state = status.parse(JSON.parse(responseText(response))).state;
    if (state === "connected") return;

    if (state !== "connecting")
      throw new Error(
        `Server ${name} is ${state}. Run gw probe --config <path> -- ${name} for fresh connections, or gw status for a running HTTP gateway.`,
      );

    await setTimeout(50, undefined, { signal });
  }
}
