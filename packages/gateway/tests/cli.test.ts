import { describe, expect, spyOn, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { configurationDocument } from "./support/configuration.ts";
import { oauthFixture } from "./support/oauth.ts";
import { type ToolList } from "codemode-mcp-gateway";
import { main } from "../src/cli/main.ts";

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
      name: "tools transport",
      args: ["tools", "list", "--transport", "stdio"],
      message: "Option --transport is not supported for gw tools list",
    },
    {
      name: "extra tools server",
      args: ["tools", "list", "notion", "jira"],
      message: "Unexpected arguments for gw tools list",
    },
    {
      name: "blank tools server",
      args: ["tools", "list", " "],
      message: "Server must be a non-empty name",
    },
    {
      name: "negative tools offset",
      args: ["tools", "list", "notes", "--offset=-1"],
      message: "--offset must be a non-negative safe integer",
    },
    {
      name: "fractional tools offset",
      args: ["tools", "list", "notes", "--offset", "1.5"],
      message: "--offset must be a non-negative safe integer",
    },
    {
      name: "unsafe tools offset",
      args: ["tools", "list", "notes", "--offset", "9007199254740992"],
      message: "--offset must be a non-negative safe integer",
    },
    {
      name: "all tools with an offset",
      args: ["tools", "list", "notes", "--all", "--offset", "0"],
      message: "--all and --offset cannot be combined",
    },
    {
      name: "JSON tools with an offset",
      args: ["tools", "list", "notes", "--json", "--offset", "0"],
      message: "--json returns the complete tool list",
    },
    {
      name: "JSON tools with all",
      args: ["tools", "list", "--json", "--all"],
      message: "--json returns the complete tool list",
    },
    {
      name: "pagination on status",
      args: ["status", "--offset", "20"],
      message: "Option --offset is not supported for gw status",
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
    expect(result.stdout).toMatch(/^  gw tools list \[server\] +List available upstream tools$/m);
    expect(result.stdout).toMatch(/^  gw serve +Run foreground HTTP MCP \(default\)$/m);
    expect(result.stdout).toMatch(/^  gw auth login \[server\] +Authorize a named upstream$/m);
    expect(result.stdout).toContain("Options:");
    expect(result.stdout).toContain("Getting started:");
    expect(result.stdout).toContain("Inspection:");
    expect(result.stdout).toContain("Authentication:");
    expect(result.stdout).not.toContain("--offset");
    expect(result.stdout).not.toContain("--transport");
    expect(result.stdout).not.toContain("--json");
  });

  test("no arguments shows help instead of starting a gateway", async () => {
    const result = await runProcess([cli]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: gw <command>");
    expect(result.stdout).toContain("Run gw help <command> for flags and examples.");
    expect(result.stderr).toBe("");
  });

  test.each([
    { name: "config group", args: ["config"], usage: "Usage: gw config <command>" },
    { name: "auth group", args: ["auth"], usage: "Usage: gw auth <command>" },
    { name: "token group", args: ["token"], usage: "Usage: gw token <command>" },
    { name: "tools group", args: ["tools"], usage: "Usage: gw tools <command>" },
    { name: "tools help", args: ["help", "tools", "list"], usage: "Usage: gw tools list [server]" },
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
    expect(result.stdout).toContain("Examples:");
    expect(result.stdout).toContain("Stdio needs no gateway HTTP token");
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

  test("focused configuration help retains default-path guidance and examples", async () => {
    const result = await runProcess([cli, "config", "check", "--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("XDG_CONFIG_HOME");
    expect(result.stdout).toContain("user-managed");
    expect(result.stdout).toContain("Examples:");
    expect(result.stdout).not.toContain("--offset");
  });

  test("unfiltered tools list pages actual qualified tool records rather than upstream statuses", async () => {
    await using catalog = await managementResponse(numberedCatalog(65));

    const result = await catalog.run(["tools", "list"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^notes.tool_01 +Description 01$/m);
    expect(result.stdout).toMatch(/^notes.tool_50 +Description 50$/m);
    expect(result.stdout).not.toContain("tool_51");
    expect(result.stdout).not.toContain("UPSTREAM");
    expect(result.stdout).toContain("Next: --offset 50");
  });

  test("unfiltered offsets page across upstreams without requiring a server argument", async () => {
    const notes = numberedCatalog(65);

    await using catalog = await managementResponse({
      tools: [...notes.tools, { server: "math", name: "math.add", description: "Add numbers" }],
      servers: [
        ...notes.servers,
        { name: "math", state: "connected", toolCount: 1, updatedAt: "2026-10-18T00:00:00.000Z" },
      ],
    });

    const result = await catalog.run(["tools", "list", "--offset", "50"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^notes.tool_51 +Description 51$/m);
    expect(result.stdout).toMatch(/^math.add +Add numbers$/m);
    expect(result.stdout).toContain("Showing 51–66 of 66 tools");
  });

  test("selected upstream text lists only the first fifty tools with a next-page hint", async () => {
    await using catalog = await managementResponse(numberedCatalog(65));

    const result = await catalog.run(["tools", "list", "notes"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Tools from notes\n");
    expect(result.stdout).toContain("TOOL     DESCRIPTION\n");
    expect(result.stdout).toMatch(/^tool_01 +Description 01$/m);
    expect(result.stdout).toMatch(/^tool_50 +Description 50$/m);
    expect(result.stdout).not.toContain("tool_51");
    expect(result.stdout).not.toContain("notes.tool_01");
    expect(result.stdout).toContain("Showing 1–50 of 65 tools\nNext: --offset 50");
  });

  test("offset selects the next page and the final page has no next-page hint", async () => {
    await using catalog = await managementResponse(numberedCatalog(65));

    const result = await catalog.run(["tools", "list", "notes", "--offset", "50"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^tool_51 +Description 51$/m);
    expect(result.stdout).toMatch(/^tool_65 +Description 65$/m);
    expect(result.stdout).not.toContain("tool_50");
    expect(result.stdout).toContain("Showing 51–65 of 65 tools");
    expect(result.stdout).not.toContain("Next:");
  });

  test("an offset beyond the catalog reports an empty page with reset guidance", async () => {
    await using catalog = await managementResponse(numberedCatalog(65));

    const result = await catalog.run(["tools", "list", "notes", "--offset", "80"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No tools at offset 80 (65 total).");
    expect(result.stdout).toContain("Reset: --offset 0");
    expect(result.stdout).not.toContain("TOOL ");
  });

  test.each([
    { name: "all upstreams", args: ["--all"], lastTool: "notes.tool_65" },
    { name: "one upstream", args: ["notes", "--all"], lastTool: "tool_65" },
  ])("explicit --all lists every tool from $name", async ({ args, lastTool }) => {
    await using catalog = await managementResponse(numberedCatalog(65));

    const result = await catalog.run(["tools", "list", ...args]);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(
      new RegExp(`^${lastTool.replace(".", "\\.")} +Description 65$`, "m"),
    );
    expect(result.stdout).toContain("\n65 tools\n");
    expect(result.stdout).not.toContain("Next:");
  });

  test("tool text fits narrow terminals and removes description line breaks and ANSI escapes", async () => {
    await using catalog = await managementResponse({
      tools: [
        {
          server: "notes",
          name: "notes.猫の検索",
          description: "line one\n\u001b[31mline two\u001b[0m " + "漢字🙂".repeat(30),
        },
      ],
      servers: [
        { name: "notes", state: "connected", toolCount: 1, updatedAt: "2026-10-18T00:00:00.000Z" },
      ],
    });

    const result = await catalog.run(["tools", "list", "notes"], 40);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("猫の検索");
    expect(result.stdout).toContain("line one line two");
    expect(result.stdout).toContain("…");
    expect(result.stdout).not.toContain("\u001b");
    expect(
      Math.max(...result.stdout.split("\n").map((line) => Bun.stringWidth(line))),
    ).toBeLessThanOrEqual(40);
  });

  test("tool JSON remains complete and untruncated regardless of terminal width", async () => {
    const listing = numberedCatalog(65);
    await using catalog = await managementResponse(listing);

    const result = await catalog.run(["tools", "list", "notes", "--json"], 20);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, ...listing });
  });

  test("tool listing warns once on stderr and directs unavailable upstreams to status", async () => {
    await using catalog = await managementResponse({
      tools: [],
      servers: [
        {
          name: "notes",
          state: "needs-auth",
          toolCount: 0,
          updatedAt: "2026-10-18T00:00:00.000Z",
          error: { kind: "required", message: "Run gw auth login notes." },
        },
      ],
    });

    const result = await catalog.run(["tools", "list"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No tools available.");
    expect(result.stdout).not.toContain("needs-auth");
    expect(result.stderr).toContain(
      "Unavailable upstreams: notes (needs-auth). Run gw status for details.",
    );
    expect(result.stderr.match(/notes \(needs-auth\)/gu)).toHaveLength(1);
  });

  test("a connected upstream with no tools is distinguished from an empty page", async () => {
    await using catalog = await managementResponse(numberedCatalog(0));

    const result = await catalog.run(["tools", "list", "notes"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("Tools from notes\n\nNo tools available.\n");
    expect(result.stderr).toBe("");
  });

  test("piped tool descriptions are untruncated single-line tab-separated records with qualified names", async () => {
    await using catalog = await managementResponse({
      tools: [
        {
          server: "notes",
          name: "notes.search",
          description: "Search\n\u001b[31mred\u001b[0m " + "漢字🙂".repeat(50),
        },
      ],
      servers: [
        { name: "notes", state: "connected", toolCount: 1, updatedAt: "2026-10-18T00:00:00.000Z" },
      ],
    });

    const result = await catalog.pipe(["tools", "list", "notes", "--all"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("notes.search\tSearch red " + "漢字🙂".repeat(50) + "\n");
    expect(result.stderr).toBe("");
  });

  test("piped tools retain the fifty-record default and put navigation only on stderr", async () => {
    await using catalog = await managementResponse(numberedCatalog(65));

    const result = await catalog.pipe(["tools", "list"]);

    expect(result.code).toBe(0);
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(50);
    expect(result.stdout).toContain("notes.tool_50\tDescription 50\n");
    expect(result.stdout).not.toContain("tool_51");
    expect(result.stdout).not.toContain("Showing");
    expect(result.stderr).toBe("Showing 1–50 of 65 tools\nNext: --offset 50\n");
  });

  test("piping an empty connected catalog emits zero records and no decoration", async () => {
    await using catalog = await managementResponse(numberedCatalog(0));

    const result = await catalog.pipe(["tools", "list"]);

    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("terminal status shows service context and wraps full failure details once", async () => {
    await using service = await managementResponse({
      service: {
        ready: true,
        pid: 12345,
        instanceId: "00000000-0000-4000-8000-000000000001",
        uptimeMs: 723000,
      },
      sessions: 2,
      upstreams: [
        {
          name: "notes",
          state: "needs-auth",
          toolCount: 0,
          updatedAt: "2026-10-18T00:00:00.000Z",
          error: {
            kind: "required",
            message:
              "Authorization is required. Run gw auth login notes with the same configuration.",
          },
        },
      ],
    });

    const result = await service.run(["status"], 40);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Gateway http://127.0.0.1:");
    expect(result.stdout).toContain("PID 12345 · Uptime 12m 3s · Sessions 2");
    expect(result.stdout).toMatch(/^notes +needs-auth +—$/m);
    expect(result.stdout.replace(/\n/gu, " ")).toContain(
      "Run gw auth login notes with the same configuration.",
    );
    expect(result.stdout.match(/Details:/gu)).toHaveLength(1);
    expect(
      Math.max(...result.stdout.split("\n").map((line) => Bun.stringWidth(line))),
    ).toBeLessThanOrEqual(40);
    expect(result.stderr).toBe("");
  });

  test("piped status contains only complete upstream records rather than the terminal service header", async () => {
    await using service = await managementResponse({
      service: {
        ready: true,
        pid: 12345,
        instanceId: "00000000-0000-4000-8000-000000000001",
        uptimeMs: 1000,
      },
      sessions: 0,
      upstreams: [
        {
          name: "notes",
          state: "failed",
          toolCount: 0,
          updatedAt: "2026-10-18T00:00:00.000Z",
          error: {
            kind: "connect",
            message: "Connection unavailable. Check the configured upstream URL and try again.",
          },
        },
      ],
    });

    const result = await service.pipe(["status"]);

    expect(result).toEqual({
      code: 0,
      stdout:
        "notes\tfailed\t0\tConnection unavailable. Check the configured upstream URL and try again.\n",
      stderr: "",
    });
  });

  test("terminal probe identifies its output as a fresh connectivity check", async () => {
    await using service = await managementResponse(numberedCatalog(0));

    const result = await service.run(["probe"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Fresh upstream connectivity check\n");
    expect(result.stdout).toMatch(/^notes +disabled +—$/m);
    expect(result.stdout).not.toContain("Gateway http:");
    expect(result.stderr).toBe("");
  });

  test("a slow terminal probe shows progress while discovery is blocked and clears it before returning", async () => {
    const release = Promise.withResolvers<void>();
    const progress = Promise.withResolvers<void>();
    const discovering = Promise.withResolvers<void>();

    await using upstream = await oauthFixture({
      mcp: async (request) => {
        if (request.method !== "POST") return;

        const body: unknown = await request.clone().json();
        if (
          typeof body === "object" &&
          body !== null &&
          "method" in body &&
          body.method === "tools/list"
        ) {
          discovering.resolve();
          await release.promise;
        }
      },
    });

    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => release.resolve());

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

    const child = Bun.spawn(
      [
        process.execPath,
        "--conditions=development",
        fileURLToPath(new URL("./fixtures/cli-terminal.ts", import.meta.url)),
        "80",
        "probe",
        "--config",
        file.path,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    cleanup.defer(async () => {
      release.resolve();
      if (child.exitCode === null) child.kill();

      await child.exited;
    });
    const output = new Response(child.stdout).text();

    const diagnostics = (async () => {
      let text = "";
      const decoder = new TextDecoder();
      for await (const chunk of child.stderr) {
        text += decoder.decode(chunk, { stream: true });
        if (text.includes("Checking upstream connections…")) progress.resolve();
      }

      return text;
    })();

    await discovering.promise;
    await progress.promise;
    release.resolve();

    expect(await child.exited).toBe(0);
    expect(await diagnostics).toBe("Checking upstream connections…\r\u001b[2K");
    expect(await output).toContain("Fresh upstream connectivity check");
  }, 10000);

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

  test("cancelling a terminal probe clears visible progress without printing a result", async () => {
    const release = Promise.withResolvers<void>();
    const progress = Promise.withResolvers<void>();

    await using upstream = await oauthFixture({
      mcp: async (request) => {
        if (request.method !== "POST") return;

        const body: unknown = await request.clone().json();
        if (
          typeof body === "object" &&
          body !== null &&
          "method" in body &&
          body.method === "tools/list"
        )
          await release.promise;
      },
    });

    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => release.resolve());

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

    const child = Bun.spawn(
      [
        process.execPath,
        "--conditions=development",
        fileURLToPath(new URL("./fixtures/cli-terminal.ts", import.meta.url)),
        "80",
        "probe",
        "--config",
        file.path,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    cleanup.defer(async () => {
      release.resolve();
      if (child.exitCode === null) child.kill();

      await child.exited;
    });
    const output = new Response(child.stdout).text();

    const diagnostics = (async () => {
      let text = "";
      const decoder = new TextDecoder();
      for await (const chunk of child.stderr) {
        text += decoder.decode(chunk, { stream: true });
        if (text.includes("Checking upstream connections…")) progress.resolve();
      }

      return text;
    })();

    await progress.promise;
    child.kill("SIGINT");
    release.resolve();

    expect(await child.exited).toBe(130);
    expect(await output).toBe("");
    expect(await diagnostics).toBe("Checking upstream connections…\r\u001b[2K");
  }, 10000);

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

function numberedCatalog(count: number): ToolList {
  return {
    tools: Array.from({ length: count }, (_unused, index) => {
      const number = String(index + 1).padStart(2, "0");

      return {
        server: "notes",
        name: `notes.tool_${number}`,
        description: `Description ${number}`,
      };
    }),
    servers: [
      {
        name: "notes",
        state: "connected",
        toolCount: count,
        updatedAt: "2026-10-18T00:00:00.000Z",
      },
    ],
  };
}

/** Synthetic management endpoint; real HTTP/CLI parsing and rendering remain under test. */
async function managementResponse(payload: unknown) {
  await using setup = new AsyncDisposableStack();

  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json(payload),
  });

  setup.defer(() => listener.stop(true));

  const file = setup.use(
    await configurationDocument({
      service: { port: Number(listener.url.port) },
      mcp: { servers: { notes: { type: "local", command: ["must-not-start"], disabled: true } } },
    }),
  );

  const cleanup = setup.move();

  return {
    run: (args: readonly string[], columns = 80) =>
      runProcess(
        [
          fileURLToPath(new URL("./fixtures/cli-terminal.ts", import.meta.url)),
          String(columns),
          "--config",
          file.path,
          ...args,
        ],
        { GW_HTTP_TOKEN: "synthetic-tool-list-http-token-0123456789" },
      ),
    pipe: (args: readonly string[]) =>
      runProcess([cli, "--config", file.path, ...args], {
        GW_HTTP_TOKEN: "synthetic-tool-list-http-token-0123456789",
      }),
    [Symbol.asyncDispose]: () => cleanup.disposeAsync(),
  };
}

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
