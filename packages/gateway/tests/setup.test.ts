import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const token = "synthetic-setup-persistent-token-0123456789";

test("explicit setup creates private gateway files without configuring MCP clients or claiming readiness", async () => {
  await using files = await fixture();
  const codex = join(files.directory, ".codex/config.toml");
  const claude = join(files.directory, ".claude.json");
  await Bun.write(codex, "user-owned TOML\n");
  await Bun.write(claude, "user-owned JSON\n");

  const result = await files.run(["setup"]);
  const saved = (await Bun.file(files.token).text()).trim();

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Created starter configuration");
  expect(result.stdout).toContain("Configuration is not ready");
  expect(result.stdout).toContain("No process was started");
  expect(result.stdout).not.toContain(saved);
  expect(saved).toMatch(/^[a-f0-9]{64}$/);
  expect(await Bun.file(files.config).json()).toEqual({ mcp: { servers: {} } });
  expect((await lstat(files.config)).mode & 0o777).toBe(0o600);
  expect((await lstat(files.token)).mode & 0o777).toBe(0o600);
  expect((await lstat(files.state)).mode & 0o777).toBe(0o700);
  expect(await readdir(files.state)).toEqual(["token"]);
  expect(await Bun.file(codex).text()).toBe("user-owned TOML\n");
  expect(await Bun.file(claude).text()).toBe("user-owned JSON\n");
  expect(
    await Bun.file(
      join(files.directory, "Library/LaunchAgents/dev.codemode-mcp-gateway.plist"),
    ).exists(),
  ).toBe(false);
});

test("repeated setup preserves the existing configuration and token without connecting upstreams", async () => {
  await using files = await fixture();

  const config =
    '{"service":{"port":4123},"mcp":{"servers":{"notes":{"type":"local","command":["must-not-run"]}}}}\n';

  await Bun.write(files.config, config);
  await files.saveToken(token);
  const original = await lstat(files.token);

  const result = await files.run(["setup"]);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Kept existing configuration");
  expect(result.stdout).toContain("Kept private HTTP token");
  expect(result.stdout).toContain("Client endpoint: http://127.0.0.1:4123/mcp");
  expect(result.stdout).toContain("upstream connectivity and authorization have not been checked");
  expect(result.stdout + result.stderr).not.toContain(token);
  expect(await Bun.file(files.config).text()).toBe(config);
  expect(await Bun.file(files.token).text()).toBe(token + "\n");
  expect((await lstat(files.token)).ino).toBe(original.ino);
});

test("setup preserves malformed user configuration instead of replacing it", async () => {
  await using files = await fixture();
  await Bun.write(files.config, "user-owned malformed JSON\n");

  const result = await files.run(["setup"]);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Configuration is not ready");
  expect(result.stdout).not.toContain("user-owned malformed");
  expect(await Bun.file(files.config).text()).toBe("user-owned malformed JSON\n");
});

test("setup preserves an existing symlinked user configuration", async () => {
  await using files = await fixture();
  const target = join(files.directory, "dotfiles-config.json");
  await Bun.write(target, "user-owned config\n");
  await mkdir(join(files.directory, "config/codemode-mcp-gateway"), { recursive: true });
  await symlink(target, files.config);

  const result = await files.run(["setup"]);

  expect(result.code).toBe(0);
  expect((await lstat(files.config)).isSymbolicLink()).toBe(true);
  expect(await Bun.file(target).text()).toBe("user-owned config\n");
});

test("concurrent setup keeps one complete persistent token", async () => {
  await using files = await fixture();

  const results = await Promise.all([files.run(["setup"]), files.run(["setup"])]);
  const shown = await files.run(["token"]);

  expect(results.map((result) => result.code)).toEqual([0, 0]);
  expect(shown.code).toBe(0);
  expect(shown.stdout).toMatch(/^[a-f0-9]{64}\n$/);
  expect(await Bun.file(files.token).text()).toBe(shown.stdout);
  expect(await readdir(files.state)).toEqual(["token"]);
});

test("token explicitly reveals a stored credential without needing configuration", async () => {
  await using files = await fixture();
  await files.saveToken(token);

  const result = await files.run(["token"]);

  expect(result).toEqual({ code: 0, stdout: token + "\n", stderr: "" });
  expect(await Bun.file(files.config).exists()).toBe(false);
});

test("environment-managed setup does not create a second credential", async () => {
  await using files = await fixture();

  const result = await files.run(["setup"], { GW_HTTP_TOKEN: token });
  const shown = await files.run(["token"], { GW_HTTP_TOKEN: token });

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("using GW_HTTP_TOKEN (not saved)");
  expect(result.stdout).not.toContain(token);
  expect(shown.stdout).toBe(token + "\n");
  expect(await Bun.file(files.token).exists()).toBe(false);
});

test("a valid environment override ignores an unusable stored token", async () => {
  await using files = await fixture();
  await files.saveToken("invalid-file-token");

  const result = await files.run(["token"], { GW_HTTP_TOKEN: token });

  expect(result).toEqual({ code: 0, stdout: token + "\n", stderr: "" });
  expect(await Bun.file(files.token).text()).toBe("invalid-file-token\n");
});

test.each([
  { name: "empty", value: "" },
  { name: "short", value: "private-short-token" },
  { name: "oversized", value: "x".repeat(257) },
  { name: "invalid characters", value: "private-invalid-token-containing spaces" },
])(
  "an $name environment override fails instead of falling back to the saved token",
  async ({ value }) => {
    await using files = await fixture();
    await files.saveToken(token);

    const result = await files.run(["setup"], { GW_HTTP_TOKEN: value });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "GW_HTTP_TOKEN must contain 32–256 letters, digits, underscores, or hyphens. Unset it to use the setup-created token file.\n",
    );
    expect(await Bun.file(files.token).text()).toBe(token + "\n");
    expect(await Bun.file(files.config).exists()).toBe(false);
  },
);

test.each([
  { name: "invalid", contents: "private-invalid-token" },
  { name: "oversized", contents: "x".repeat(259) },
])("setup refuses an $name saved credential without replacing it", async ({ contents }) => {
  await using files = await fixture();
  await files.saveToken(contents);

  const result = await files.run(["setup"]);

  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    "The HTTP token file is invalid. It must contain one private token of 32–256 letters, digits, underscores, or hyphens.\n",
  );
  expect(await Bun.file(files.token).text()).toBe(contents + "\n");
  expect(await Bun.file(files.config).exists()).toBe(false);
});

test("setup refuses a symlinked token file without touching its target", async () => {
  await using files = await fixture();
  const target = join(files.directory, "private-token");
  await Bun.write(target, token + "\n");
  await mkdir(files.state, { recursive: true, mode: 0o700 });
  await symlink(target, files.token);

  const result = await files.run(["setup"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("non-symlinked private file");
  expect(result.stdout + result.stderr).not.toContain(token);
  expect((await lstat(files.token)).isSymbolicLink()).toBe(true);
  expect(await Bun.file(target).text()).toBe(token + "\n");
});

test.each([
  { name: "directory", suffix: "", mode: 0o755, message: "mode 0700" },
  { name: "file", suffix: "/token", mode: 0o644, message: "mode 0600" },
])(
  "setup refuses a nonprivate token $name without fixing permissions silently",
  async ({ suffix, mode, message }) => {
    await using files = await fixture();
    await files.saveToken(token);
    await chmod(files.state + suffix, mode);

    const result = await files.run(["setup"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stdout + result.stderr).not.toContain(token);
    expect((await lstat(files.state + suffix)).mode & 0o777).toBe(mode);
    expect(await Bun.file(files.token).text()).toBe(token + "\n");
  },
);

test("setup refuses a symlinked token directory without writing into it", async () => {
  await using files = await fixture();
  const target = join(files.directory, "private-state");
  await mkdir(target, { mode: 0o700 });
  await mkdir(join(files.directory, "state"));
  await symlink(target, files.state);

  const result = await files.run(["setup"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("not symlinked");
  expect(await readdir(target)).toEqual([]);
});

test("setup honors an explicit configuration path without changing its default", async () => {
  await using files = await fixture();
  const config = join(files.directory, "custom/config.json");

  const result = await files.run(["setup", "--config", config]);

  expect(result.code).toBe(0);
  expect(await Bun.file(config).json()).toEqual({ mcp: { servers: {} } });
  expect(await Bun.file(files.config).exists()).toBe(false);
});

test("setup refuses a directory at the configuration path without replacing it", async () => {
  await using files = await fixture();
  await mkdir(files.config, { recursive: true });

  const result = await files.run(["setup"]);

  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("configuration path must refer to a regular file");
  expect((await lstat(files.config)).isDirectory()).toBe(true);
});

test("setup reports an obstructed configuration directory without claiming success", async () => {
  await using files = await fixture();
  const parent = join(files.directory, "config/codemode-mcp-gateway");
  await Bun.write(parent, "user-owned file\n");

  const result = await files.run(["setup"]);

  expect(result).toEqual({
    code: 1,
    stdout: "",
    stderr: "Could not create the gateway configuration directory.\n",
  });
  expect(await Bun.file(parent).text()).toBe("user-owned file\n");
});

test("setup rejects a relative state home without creating files", async () => {
  await using files = await fixture();

  const result = await files.run(["setup"], { XDG_STATE_HOME: "relative-state" });

  expect(result).toEqual({
    code: 1,
    stdout: "",
    stderr: "XDG_STATE_HOME must be an absolute path.\n",
  });
  expect(await Bun.file(files.config).exists()).toBe(false);
  expect(await Bun.file(files.token).exists()).toBe(false);
});

test("reading a missing token explains setup without creating any state", async () => {
  await using files = await fixture();

  const result = await files.run(["token"]);

  expect(result).toEqual({
    code: 1,
    stdout: "",
    stderr: "No HTTP token is configured. Run gw setup or set GW_HTTP_TOKEN.\n",
  });
  expect(await Bun.file(files.token).exists()).toBe(false);
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gw-setup-"));
  const state = join(directory, "state/codemode-mcp-gateway");
  const tokenPath = join(state, "token");

  return {
    directory,
    state,
    token: tokenPath,
    config: join(directory, "config/codemode-mcp-gateway/config.json"),
    async saveToken(value: string) {
      await mkdir(state, { recursive: true, mode: 0o700 });
      await Bun.write(tokenPath, value + "\n");
      await chmod(tokenPath, 0o600);
    },
    async run(args: string[], environment: NodeJS.ProcessEnv = {}) {
      const child = Bun.spawn([process.execPath, "--conditions=development", cli, ...args], {
        cwd: directory,
        env: {
          ...process.env,
          HOME: directory,
          XDG_CONFIG_HOME: join(directory, "config"),
          XDG_STATE_HOME: join(directory, "state"),
          GW_HTTP_TOKEN: undefined,
          PATH: "",
          ...environment,
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);

        return { code, stdout, stderr };
      } finally {
        clearTimeout(timeout);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    },
    [Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true }),
  };
}
