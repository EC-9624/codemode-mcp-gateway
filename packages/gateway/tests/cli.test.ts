import { describe, expect, spyOn, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { configurationDocument } from "./support/configuration.ts";
import { oauthFixture } from "./support/oauth.ts";
import { main } from "../src/main.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

describe("gw executable", () => {
  test("interrupted check exits 130 without reporting successful validation", async () => {
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
    cleanup.defer(() => release.resolve());

    const checking = main(["check", "unused-check.json", "--json"]);
    await reading.promise;
    process.emit("SIGINT");
    release.resolve();

    expect(await checking).toBe(130);
    expect(output).not.toHaveBeenCalled();
  });
  test.each([
    { name: "extra arguments", args: ["unused.json", "extra"] },
    { name: "unknown command", args: ["unknown", "unused.json"] },
    { name: "competing paths", args: ["check", "one.json", "--config", "two.json"] },
    { name: "JSON protocol pollution", args: ["serve", "--json"] },
    { name: "unknown option", args: ["--unknown"] },
  ])("rejects $name with usage on stderr", async ({ args }) => {
    const result = await runProcess([cli, ...args]);

    expect(result).toEqual({
      code: 2,
      stdout: "",
      stderr: "Invalid arguments. Run gw --help for usage.\n",
    });
  });

  test("help documents commands without requiring configuration", async () => {
    const result = await runProcess([cli, "--help"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("gw login --server <name>");
    expect(result.stdout).toContain("XDG_CONFIG_HOME");
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

    const result = await runProcess([cli, "check", "--json"], { XDG_CONFIG_HOME: directory });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      configuration: join(directory, "codemode-mcp-gateway/config.json"),
      servers: ["absent"],
    });
    expect(result.stderr).toBe("");
  });

  test("doctor reports a failed connection without leaking private diagnostics", async () => {
    await using file = await configurationDocument({
      mcp: { servers: { missing: { type: "local", command: ["missing-cmg-private-command"] } } },
    });

    const result = await runProcess([cli, "doctor", "--config", file.path, "--json"]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      servers: [{ name: "missing", state: "failed", toolCount: 0, error: { kind: "connect" } }],
    });
    expect(result.stdout + result.stderr).not.toContain("missing-cmg-private-command");
  });

  test("doctor rejects an implicit default alias", async () => {
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

    const result = await runProcess([
      cli,
      "doctor",
      "--config",
      file.path,
      "--server",
      "default",
      "--json",
    ]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: { message: 'Unknown server "default".' },
    });
    expect(upstream.requests).toHaveLength(0);
    expect(result.stderr).toBe("");
  });

  test("doctor connects only the explicitly selected named server", async () => {
    await using file = await configurationDocument({
      mcp: {
        servers: {
          paused: { type: "local", command: ["unused-cmg-command"], disabled: true },
          unavailable: { type: "local", command: ["missing-cmg-command"] },
        },
      },
    });

    const result = await runProcess([
      cli,
      "doctor",
      "--config",
      file.path,
      "--server",
      "paused",
      "--json",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      servers: [{ name: "paused", state: "disabled", toolCount: 0 }],
    });
    expect(result.stderr).toBe("");
  });

  test("reports an unreadable configuration without writing protocol output", async () => {
    const path = fileURLToPath(new URL("./fixtures/missing-configuration.json", import.meta.url));

    const result = await runProcess([cli, path]);

    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: `Could not read configuration JSON at ${path}.\n`,
    });
  });

  test("doctor emits one failing JSON result when session cleanup fails", async () => {
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

    const result = await runProcess([cli, "doctor", "--config", file.path, "--json"]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: {
        message: "CMG server failed. Private diagnostics were not displayed.",
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
