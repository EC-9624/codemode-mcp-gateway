import { main } from "../../src/main.ts";
import { Credentials, type CredentialStore } from "codemode-mcp-gateway";
import { rename } from "node:fs/promises";

// The CLI dispatcher accepts a store seam; running it here preserves CLI diagnostics
// and process shutdown behavior without invoking the production OS credential service.
// Synthetic credentials only. Production entry points never select this file-backed test store.
const path = process.env.CMG_TEST_CREDENTIALS;
const directory = process.env.CMG_TEST_LOCKS;
if (path === undefined || directory === undefined) throw new Error("Missing OAuth fixture paths");

const store = {
  async load() {
    if (!(await Bun.file(path).exists())) return { ok: true, value: undefined };

    const input: unknown = await Bun.file(path).json();
    const parsed = Credentials.safeParse(input);

    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, error: { kind: "invalid", message: "Invalid synthetic credentials" } };
  },
  async save(value) {
    if (process.env.CMG_TEST_SAVE_FAILURE === "true") {
      return { ok: false, error: { kind: "storage", message: "Synthetic store failure" } };
    }

    const temporary = path + "." + process.pid;
    await Bun.write(temporary, JSON.stringify(value));
    await rename(temporary, path);

    return { ok: true, value: undefined };
  },
  async clear() {
    await Bun.file(path).delete();

    return { ok: true, value: undefined };
  },
} satisfies CredentialStore;

process.exitCode = await main(process.argv.slice(2), {
  store: () => store,
  lockDirectory: directory,
});
