import { resolve } from "node:path";
import { serve } from "./server.ts";

/** Run the CLI command and return its exit status. */
export async function main(args: readonly string[]): Promise<number> {
  const path = args[0];
  if (path === undefined || args.length !== 1) {
    console.error("Usage: cmg <configuration.json>");

    return 1;
  }

  try {
    await serve(resolve(path));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "CMG server failed.");

    return 1;
  }

  return 0;
}
