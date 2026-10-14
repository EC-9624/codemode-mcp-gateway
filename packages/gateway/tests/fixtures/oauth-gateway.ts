import { main } from "../../src/main.ts";
import { Credentials, type CredentialStore } from "../../src/index.ts";
import { AuthResult } from "../../src/auth/result.ts";
import { rename } from "node:fs/promises";

// Synthetic credentials only. Production entry points never select this file-backed test store.
const path = process.env.CMG_TEST_CREDENTIALS;
const directory = process.env.CMG_TEST_LOCKS;
if (path === undefined || directory === undefined) throw new Error("Missing OAuth fixture paths");

const store = {
  async load() {
    if (!(await Bun.file(path).exists())) return AuthResult.success(undefined);

    const input: unknown = await Bun.file(path).json();
    const parsed = Credentials.safeParse(input);

    return parsed.success
      ? AuthResult.success(parsed.data)
      : AuthResult.failure("invalid", "Invalid synthetic credentials");
  },
  async save(value) {
    const temporary = path + "." + process.pid;
    await Bun.write(temporary, JSON.stringify(value));
    await rename(temporary, path);

    return AuthResult.success(undefined);
  },
  async clear() {
    await Bun.file(path).delete();

    return AuthResult.success(undefined);
  },
} satisfies CredentialStore;

process.exitCode = await main(process.argv.slice(2), {
  store: () => store,
  lockDirectory: directory,
});
