import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Credentials } from "codemode-mcp-gateway";
import { configuration } from "./support/configuration.ts";
import { credentialFiles } from "./support/credentials.ts";
import { oauthFixture } from "./support/oauth.ts";

describe("default file-backed OAuth credentials", () => {
  test.each(["explicit XDG state", "empty XDG state"])(
    "%s persists login and refresh across service processes until logout",
    async (location) => {
      await using files = await credentialFiles();
      await using upstream = await oauthFixture();
      await using config = await configuration({ type: "remote", url: upstream.url, oauth: {} });
      const xdg = location === "explicit XDG state" ? join(files.root, "state") : "";
      const state = join(xdg || join(files.root, ".local", "state"), "codemode-mcp-gateway");
      const env = { ...process.env, HOME: files.root, XDG_STATE_HOME: xdg };

      expect(await run("login", config.path, env)).toEqual({
        code: 0,
        stdout: "logged in\n",
        stderr: "",
      });
      expect((await readdir(state)).sort()).toEqual(["credentials", "locks"]);
      const names = await readdir(join(state, "credentials"));
      expect(names).toHaveLength(1);
      const name = names[0];
      if (name === undefined) throw new Error("Expected saved OAuth credentials.");

      const path = join(state, "credentials", name);
      const before = Credentials.parse(await Bun.file(path).json());
      expect(before.authorization).toMatchObject({
        status: "authorized",
        tokens: { access_token: "access-1" },
      });
      upstream.rejectAccess();

      expect(await run("call", config.path, env)).toEqual({
        code: 0,
        stdout: "called\n",
        stderr: "",
      });
      expect(await run("call", config.path, env)).toEqual({
        code: 0,
        stdout: "called\n",
        stderr: "",
      });
      const after = Credentials.parse(await Bun.file(path).json());
      expect(after.authorization).toMatchObject({
        status: "authorized",
        tokens: { access_token: "access-2", refresh_token: "refresh-2" },
      });
      expect(upstream.exchanges).toBe(1);
      expect(upstream.refreshes).toBe(1);

      expect(await run("logout", config.path, env)).toEqual({
        code: 0,
        stdout: "logged out\n",
        stderr: "",
      });
      expect(await readdir(join(state, "credentials"))).toEqual([]);
      expect(await run("load", config.path, env)).toEqual({
        code: 0,
        stdout: '{"ok":true}\n',
        stderr: "",
      });
    },
    15_000,
  );

  test("relative XDG state fails credential reads instead of using the working directory", async () => {
    await using files = await credentialFiles();

    await using config = await configuration({
      type: "remote",
      url: "https://example.com/",
      oauth: {},
    });

    const result = await run("load", config.path, {
      ...process.env,
      HOME: files.root,
      XDG_STATE_HOME: "relative",
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { kind: "invalid", message: "XDG_STATE_HOME must be an absolute path." },
    });
    expect(await readdir(files.root)).not.toContain("relative");
  });
});

async function run(operation: string, path: string, env: NodeJS.ProcessEnv & { HOME: string }) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=development",
      fileURLToPath(new URL("./fixtures/file-credentials.ts", import.meta.url)),
      operation,
      path,
    ],
    { cwd: env.HOME, env, stdout: "pipe", stderr: "pipe" },
  );

  const watchdog = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    return { code, stdout, stderr };
  } finally {
    clearTimeout(watchdog);
    child.kill("SIGKILL");
    await child.exited;
  }
}
