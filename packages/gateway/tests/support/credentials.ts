import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileCredentialStore, type OAuthConnection } from "codemode-mcp-gateway";

/** Isolated real filesystem for credential adapter and workflow boundary tests. */
export async function credentialFiles() {
  const root = await mkdtemp(join(tmpdir(), "codemode-mcp-gateway-credentials-"));
  const directory = join(root, "credentials");

  return {
    root,
    directory,
    store: (connection: OAuthConnection) => fileCredentialStore(connection, { directory }),
    async path() {
      const names = await readdir(directory);
      const name = names[0];
      if (names.length !== 1 || name === undefined)
        throw new Error("Expected exactly one saved credential snapshot.");

      return join(directory, name);
    },
    [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
  };
}
