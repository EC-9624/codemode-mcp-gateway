import { describe, expect, spyOn, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { configurationDocument } from "./support/configuration.ts";
import { oauthFixture } from "./support/oauth.ts";
import { main } from "../src/main.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

describe("gw executable", () => {
  test.each([
    { name: "config check", args: ["config", "check", "--json"], signal: "SIGINT", code: 130 },
    { name: "config check", args: ["config", "check", "--json"], signal: "SIGTERM", code: 143 },
    { name: "stdio serving", args: ["serve", "--transport", "stdio"], signal: "SIGINT", code: 130 },
    { name: "default HTTP serving", args: ["serve"], signal: "SIGTERM", code: 143 },
  ] as const)(
    "$name exits $code on $signal during config loading without starting work or reporting success",
    async ({ args, signal, code }) => {
      const reading = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const file = Bun.file("unused-check.json");
      using cleanup = new DisposableStack();
      cleanup.use(
        spyOn(file, "json").mockImplementation(async () => {
          reading.resolve();
          await release.promise;

          return {
            mcp: { servers: { paused: { type: "local", command: ["unused"], disabled: true } } },
          };
        }),
      );
      cleanup.use(spyOn(Bun, "file").mockReturnValue(file));
      using output = spyOn(console, "log").mockImplementation(() => {});
      using diagnostics = spyOn(console, "error").mockImplementation(() => {});
      cleanup.defer(() => release.resolve());

      const checking = main([...args, "--config", "unused-check.json"]);
      await reading.promise;
      process.emit(signal);
      release.resolve();

      expect(await checking).toBe(code);
      expect(output).not.toHaveBeenCalled();
      expect(diagnostics).not.toHaveBeenCalled();
    },
  );
  test.each([
    { name: "positional configuration", args: ["unused.json"], message: "Unknown command" },
    { name: "unknown command", args: ["unknown"], message: "Unknown command" },
    {
      name: "extra configuration path",
      args: ["config", "check", "one.json", "--config", "two.json"],
      message: "Unexpected arguments",
    },
    {
      name: "JSON protocol pollution",
      args: ["serve", "--json"],
      message: "Option --json is not supported for gw serve",
    },
    { name: "unknown option", args: ["--unknown"], message: "Unknown option" },
    { name: "removed service command", args: ["service"], message: "Unknown command" },
    { name: "removed doctor command", args: ["doctor"], message: "Unknown command" },
    { name: "removed top-level check", args: ["check"], message: "Unknown command" },
    { name: "removed top-level login", args: ["login"], message: "Unknown command" },
    { name: "removed top-level logout", args: ["logout"], message: "Unknown command" },
    { name: "removed stdio flag", args: ["serve", "--stdio"], message: "Unknown option" },
    {
      name: "removed server flag",
      args: ["auth", "login", "--server", "notes"],
      message: "Unknown option",
    },
    {
      name: "token configuration",
      args: ["token", "show", "--config", "unused.json"],
      message: "Option --config is not supported",
    },
    {
      name: "login JSON",
      args: ["auth", "login", "--json"],
      message: "Option --json is not supported",
    },
    {
      name: "probe transport",
      args: ["probe", "--transport", "stdio"],
      message: "Option --transport is not supported",
    },
    {
      name: "blank configuration",
      args: ["config", "check", "--config", " "],
      message: "--config must be a non-empty path",
    },
    { name: "blank server", args: ["probe", " "], message: "Server must be a non-empty name" },
    {
      name: "invalid transport",
      args: ["serve", "--transport", "socket"],
      message: "--transport must be stdio or http",
    },
    {
      name: "duplicate config flags",
      args: ["serve", "-c", "one.json", "--config", "two.json"],
      message: "Option --config may only be supplied once",
    },
    { name: "missing option value", args: ["serve", "--config"], message: "argument missing" },
    {
      name: "configuration without a command",
      args: ["--config", "unused.json"],
      message: "Option --config is not supported for gw",
    },
    { name: "unknown help topic", args: ["help", "unknown"], message: "Unknown command" },
  ])("rejects $name with a specific error and usage on stderr", async ({ args, message }) => {
    const result = await runProcess([cli, ...args]);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain("Run gw help");
  });

  test("help lists commands beside short descriptions without requiring configuration", async () => {
    const result = await runProcess([cli, "--help"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("auth login [server]");
    expect(result.stdout).toMatch(/^  gw serve +Run foreground HTTP MCP \(default\)$/m);
    expect(result.stdout).toMatch(/^  gw auth login \[server\] +Authorize a named upstream$/m);
    expect(result.stdout).toContain("Options:");
    expect(result.stdout).toContain("XDG_CONFIG_HOME");
  });

  test("no arguments shows help instead of starting a gateway", async () => {
    const result = await runProcess([cli]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Stdio needs no gateway HTTP token");
    expect(result.stdout).toContain("user-managed");
    expect(result.stderr).toBe("");
  });

  test.each([
    { name: "config group", args: ["config"], usage: "Usage: gw config <command>" },
    { name: "auth group", args: ["auth"], usage: "Usage: gw auth <command>" },
    { name: "token group", args: ["token"], usage: "Usage: gw token <command>" },
    {
      name: "nested help",
      args: ["help", "auth", "login"],
      usage: "Usage: gw auth login [server]",
    },
    {
      name: "nested help flag",
      args: ["config", "check", "--help"],
      usage: "Usage: gw config check",
    },
  ])("$name shows focused help without requiring configuration", async ({ args, usage }) => {
    const result = await runProcess([cli, ...args], { XDG_CONFIG_HOME: "invalid-relative-config" });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(usage);
  });

  test("serve help documents HTTP by default and explicit stdio without unrelated JSON options", async () => {
    const result = await runProcess([cli, "serve", "-h"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("HTTP MCP (default)");
    expect(result.stdout).toContain("--transport stdio");
    expect(result.stdout).toContain("stdout is exclusively MCP traffic");
    expect(result.stdout).not.toContain("--json");
  });

  test("auth group help lists only its commands with short descriptions", async () => {
    const result = await runProcess([cli, "auth", "--help"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/^  gw auth login \[server\] +Authorize a named upstream$/m);
    expect(result.stdout).toMatch(
      /^  gw auth logout \[server\] +Remove local upstream credentials$/m,
    );
    expect(result.stdout).not.toContain("gw token show");
  });

  test("config check emits one controlled JSON failure for an unreadable file", async () => {
    const path = fileURLToPath(new URL("./fixtures/missing-configuration.json", import.meta.url));

    const result = await runProcess([cli, "-c", path, "config", "check", "--json"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: { message: `Could not read configuration JSON at ${path}.` },
    });
  });

  test("probe accepts a leading-hyphen server after the option terminator", async () => {
    await using file = await configurationDocument({
      mcp: {
        servers: {
          "-paused": { type: "local", command: ["unused"], disabled: true },
          unavailable: { type: "local", command: ["must-not-start"] },
        },
      },
    });

    const result = await runProcess([cli, "probe", "-c", file.path, "--json", "--", "-paused"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      servers: [{ name: "-paused", state: "disabled" }],
    });
  });

  test("prints the installed version without connecting", async () => {
    expect(await runProcess([cli, "--version"])).toEqual({
      code: 0,
      stdout: "gw 0.0.0\n",
      stderr: "",
    });
  });

  test("check loads XDG configuration and does not execute configured commands", async () => {
    await using file = await configurationDocument({});
    const directory = dirname(file.path);
    await Bun.write(
      join(directory, "codemode-mcp-gateway/config.json"),
      JSON.stringify({
        mcp: { servers: { absent: { type: "local", command: ["nonexistent-cmg-command"] } } },
      }),
    );

    const result = await runProcess([cli, "config", "check", "--json"], {
      XDG_CONFIG_HOME: directory,
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      configuration: join(directory, "codemode-mcp-gateway/config.json"),
      servers: ["absent"],
    });
    expect(result.stderr).toBe("");
  });

  test("probe reports a failed connection without leaking private diagnostics", async () => {
    await using file = await configurationDocument({
      mcp: { servers: { missing: { type: "local", command: ["missing-cmg-private-command"] } } },
    });

    const result = await runProcess([cli, "probe", "--config", file.path, "--json"]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      servers: [{ name: "missing", state: "failed", toolCount: 0, error: { kind: "connect" } }],
    });
    expect(result.stdout + result.stderr).not.toContain("missing-cmg-private-command");
  });

  test("probe rejects an implicit default alias", async () => {
    await using upstream = await oauthFixture();

    await using file = await configurationDocument({
      mcp: {
        servers: {
          notes: {
            type: "remote",
            url: upstream.url,
            headers: { Authorization: "Bearer access-0" },
          },
        },
      },
    });

    const result = await runProcess([cli, "probe", "default", "--config", file.path, "--json"]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: { message: 'Unknown server "default".' },
    });
    expect(upstream.requests).toHaveLength(0);
    expect(result.stderr).toBe("");
  });

  test("probe connects only the explicitly selected named server", async () => {
    await using file = await configurationDocument({
      mcp: {
        servers: {
          paused: { type: "local", command: ["unused-cmg-command"], disabled: true },
          unavailable: { type: "local", command: ["missing-cmg-command"] },
        },
      },
    });

    const result = await runProcess([cli, "probe", "paused", "--config", file.path, "--json"], {
      GW_HTTP_TOKEN: undefined,
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      servers: [{ name: "paused", state: "disabled", toolCount: 0 }],
    });
    expect(result.stderr).toBe("");
  });

  test("reports an unreadable configuration without writing protocol output", async () => {
    const path = fileURLToPath(new URL("./fixtures/missing-configuration.json", import.meta.url));

    const result = await runProcess([cli, "serve", "--config", path]);

    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: `Could not read configuration JSON at ${path}.\n`,
    });
  });

  test("probe emits one failing JSON result when session cleanup fails", async () => {
    await using upstream = await oauthFixture({
      mcp: async (request) =>
        request.method === "DELETE"
          ? new Response("Private session deletion failure", { status: 503 })
          : undefined,
    });

    await using file = await configurationDocument({
      mcp: {
        servers: {
          notes: {
            type: "remote",
            url: upstream.url,
            headers: { Authorization: "Bearer access-0" },
          },
        },
      },
    });

    const result = await runProcess([cli, "probe", "--config", file.path, "--json"]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: {
        message: "Gateway command failed. Private diagnostics were not displayed.",
      },
    });
    expect(result.stderr).toBe("");
    expect(upstream.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
  });

  test("the programmatic entry leaves shutdown listeners unchanged and lets the process exit", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/import-gateway.ts", import.meta.url));

    const result = await runProcess([fixture]);

    expect(result).toEqual({ code: 0, stdout: "gateway-imported\n", stderr: "" });
  });
});

async function runProcess(args: string[], environment: NodeJS.ProcessEnv = {}) {
  const child = Bun.spawn([process.execPath, "--conditions=development", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...environment },
  });

  const timer = setTimeout(() => child.kill(), 4_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}
