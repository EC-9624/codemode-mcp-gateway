import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Configuration } from "codemode-mcp-gateway";

/** Write only the supplied configuration; the scenario owns its policy and connection. */
export async function configuration(upstream: Configuration["upstream"]) {
  const directory = await mkdtemp(join(tmpdir(), "cmg-configuration-"));
  const path = join(directory, "config.json");
  try {
    await Bun.write(path, JSON.stringify({ upstream }));
  } catch (cause) {
    await rm(directory, { recursive: true, force: true });
    throw cause;
  }

  return {
    path,
    lockDirectory: join(directory, "locks"),
    [Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true }),
  };
}
