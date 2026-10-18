import { z } from "zod";

declare const GW_BUILD_VERSION: string;

/** Standalone builds embed this value; source and packed runs read their own manifest. */
export async function gatewayVersion(): Promise<string> {
  if (typeof GW_BUILD_VERSION !== "undefined") return GW_BUILD_VERSION;

  return z
    .object({ version: z.string() })
    .parse(await Bun.file(new URL("../package.json", import.meta.url)).json()).version;
}
