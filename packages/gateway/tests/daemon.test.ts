import { expect, spyOn, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { responseText } from "./support/output.ts";
import { main } from "../src/main.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("HTTP serving logs protocol failures without exposing upstream response data", async () => {
  await using files = await fixture();
  await Bun.write(
    files.config,
    JSON.stringify({
      service: { port: files.port },
      mcp: {
        servers: {
          test: {
            type: "local",
            command: [
              process.execPath,
              fileURLToPath(new URL("./fixtures/gateway-upstream.ts", import.meta.url)),
              "malformed",
            ],
          },
        },
      },
    }),
  );
  const app = await start(files, {}, '"state":"connected"');
  const token = await files.readToken();
  const client = new Client({ name: "daemon-diagnostics", version: "1" });
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${files.origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );

  const response = await client.callTool({
    name: "execute",
    arguments: { code: 'return await tools["test.malformed"]({});' },
  });

  await app.stop();
  const logs = await app.logs;

  expect(response.isError).toBe(true);
  expect(responseText(response)).toBe(
    "MCP tool \"malformed\" failed (code -32602): Structured content does not match the tool's output schema: data must have required property 'sum'",
  );
  expect(logs).toContain('"tool":"test.malformed","callId":1');
  expect(logs).toContain('"name":"ProtocolError"');
  expect(logs + JSON.stringify(response)).not.toContain("upstream-private-detail");
  expect(logs).not.toContain(token);
});

test("service start reuses a matching daemon and reads one configuration snapshot", async () => {
  await using files = await fixture();
  const app = await start(files);
  await Bun.write(
    join(files.directory, "Library/LaunchAgents/dev.codemode-mcp-gateway.plist"),
    "synthetic service definition\n",
  );
  using cleanup = serviceEnvironment(files);
  const nativeSpawn = Bun.spawn;
  const operations: unknown[] = [];

  cleanup.use(
    spyOn(Bun, "spawn").mockImplementation((...args) => {
      const command = args[0];
      if (!Array.isArray(command) || command[0] !== "/bin/launchctl")
        throw new Error("Expected a launchctl operation");

      operations.push(command[1]);

      return nativeSpawn([process.execPath, "-e", `console.log("pid = ${app.child.pid}")`], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    }),
  );

  const file = Bun.file(files.config);
  const reading = cleanup.use(spyOn(file, "json"));
  cleanup.use(spyOn(Bun, "file").mockReturnValue(file));
  const output = cleanup.use(spyOn(console, "log").mockImplementation(() => {}));
  cleanup.use(spyOn(console, "error").mockImplementation(() => {}));

  const code = await main(["service", "start", "--config", files.config, "--json"]);

  expect(code).toBe(0);
  expect(reading).toHaveBeenCalledTimes(1);
  expect(new Set(operations)).toEqual(new Set(["print"]));
  expect(output).toHaveBeenCalledWith(
    JSON.stringify({
      action: "start",
      completed: true,
      clients: [
        { client: "codex", state: "unchanged", path: files.codex },
        { client: "claude", state: "unchanged", path: files.claude },
      ],
    }),
  );
  await app.stop();
});

test("service stop waits for owned process exit without requiring a configuration file", async () => {
  await using files = await fixture();
  using environment = serviceEnvironment(files);
  const nativeSpawn = Bun.spawn;

  const owned = nativeSpawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    stdout: "ignore",
    stderr: "ignore",
  });

  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(async () => {
    owned.kill("SIGTERM");
    await owned.exited;
  });
  const waiting = Promise.withResolvers<void>();
  const kill = process.kill.bind(process);
  environment.use(
    spyOn(process, "kill").mockImplementation((pid, signal) => {
      const result = kill(pid, signal);
      if (pid === owned.pid && signal === 0) waiting.resolve();

      return result;
    }),
  );

  environment.use(
    spyOn(Bun, "spawn").mockImplementation((...args) => {
      const command = args[0];
      if (!Array.isArray(command) || command[0] !== "/bin/launchctl")
        throw new Error("Expected a launchctl operation");

      return nativeSpawn([process.execPath, "-e", `console.log("pid = ${owned.pid}")`], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    }),
  );
  const output = environment.use(spyOn(console, "log").mockImplementation(() => {}));
  let settled = false;

  const stopping = main([
    "service",
    "stop",
    "--config",
    join(files.directory, "missing.json"),
    "--json",
  ]).then((code) => {
    settled = true;

    return code;
  });

  await waiting.promise;
  expect(settled).toBe(false);
  owned.kill("SIGTERM");
  await owned.exited;

  expect(await stopping).toBe(0);
  expect(output).toHaveBeenCalledWith('{"action":"stop","completed":true}');
});

test("serve registers private native headers while preserving unrelated client settings", async () => {
  await using files = await fixture();

  const preferences =
    '# Keep this comment\nmodel = "synthetic-model"\nnotes = """\n[mcp_servers.not-a-table]\n"""\n';

  await Bun.write(
    files.codex,
    preferences + '[mcp_servers.other]\nurl = "https://other.example/mcp"\n',
  );
  await Bun.write(
    files.claude,
    JSON.stringify({
      account: { preserve: true },
      mcpServers: { other: { type: "http", url: "https://other.example/mcp" } },
    }),
  );

  const app = await start(files);
  const token = await files.readToken();
  const codexText = await Bun.file(files.codex).text();
  const codex = z.object({ mcp_servers: z.unknown() }).parse(Bun.TOML.parse(codexText));

  const claude = z
    .object({ account: z.unknown(), mcpServers: z.record(z.string(), z.unknown()) })
    .parse(await Bun.file(files.claude).json());

  expect(app.status.clients).toEqual([
    { client: "codex", state: "configured", path: files.codex },
    { client: "claude", state: "configured", path: files.claude },
  ]);
  expect(codexText).toContain(preferences);
  expect(codex.mcp_servers).toEqual({
    other: { url: "https://other.example/mcp" },
    "codemode-mcp-gateway": {
      url: `${files.origin}/mcp`,
      http_headers: { Authorization: `Bearer ${token}` },
    },
  });
  expect(claude.account).toEqual({ preserve: true });
  expect(claude.mcpServers).toEqual({
    other: { type: "http", url: "https://other.example/mcp" },
    "codemode-mcp-gateway": {
      type: "http",
      url: `${files.origin}/mcp`,
      headers: { Authorization: `Bearer ${token}` },
    },
  });
  expect((await stat(files.codex)).mode & 0o777).toBe(0o600);
  expect((await stat(files.claude)).mode & 0o777).toBe(0o600);
  await app.stop();
  expect(await app.logs).not.toContain(token);
});

test.each([
  {
    name: "nested tables",
    text: '[mcp_servers."codemode-mcp-gateway"]\ncommand="obsolete"\nargs=["old"]\nbearer_token_env_var="GW_SERVICE_TOKEN"\ntool_timeout_sec=60\n[mcp_servers."codemode-mcp-gateway".tools.execute]\napproval_mode="approve"\n',
  },
  {
    name: "inline server map",
    text: 'mcp_servers = { "codemode-mcp-gateway" = { command="obsolete", tool_timeout_sec=60, tools={execute={approval_mode="approve"}} } }\n',
  },
  {
    name: "dotted keys",
    text: 'mcp_servers.codemode-mcp-gateway.command="obsolete"\nmcp_servers.codemode-mcp-gateway.tool_timeout_sec=60\nmcp_servers.codemode-mcp-gateway.tools.execute.approval_mode="approve"\n',
  },
])("serve migrates $name without losing the gateway tool policy", async ({ text }) => {
  await using files = await fixture();
  await Bun.write(files.codex, text);
  await Bun.write(
    files.claude,
    JSON.stringify({
      mcpServers: {
        "codemode-mcp-gateway": {
          type: "stdio",
          command: "obsolete",
          args: ["old"],
          headersHelper: "old",
        },
      },
    }),
  );

  const app = await start(files);
  const token = await files.readToken();

  expect(app.status.clients.map((client) => client.state)).toEqual(["configured", "configured"]);
  expect(
    z.object({ mcp_servers: z.unknown() }).parse(Bun.TOML.parse(await Bun.file(files.codex).text()))
      .mcp_servers,
  ).toEqual({
    "codemode-mcp-gateway": {
      url: `${files.origin}/mcp`,
      http_headers: { Authorization: `Bearer ${token}` },
      tool_timeout_sec: 60,
      tools: { execute: { approval_mode: "approve" } },
    },
  });
  expect(await Bun.file(files.claude).json()).toEqual({
    mcpServers: {
      "codemode-mcp-gateway": {
        type: "http",
        url: `${files.origin}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  });
  await app.stop();
});

test("serve rotates native bearer tokens across restarts without replacing its private signing key", async () => {
  await using files = await fixture();
  const first = await start(files);
  const previous = await files.readToken();
  await first.stop();
  const key = await Bun.file(files.token).text();

  const second = await start(files);
  const current = await files.readToken();

  const rejected = await fetch(`${files.origin}/status`, {
    headers: { authorization: `Bearer ${previous}` },
  });

  expect(second.status.clients.map((client) => client.state)).toEqual(["configured", "configured"]);
  expect(current).not.toBe(previous);
  expect(rejected.status).toBe(401);
  expect(await Bun.file(files.token).text()).toBe(key);
  await second.stop();
});

test("serve reports a malformed client config while the other client remains configured", async () => {
  await using files = await fixture();
  const malformed = 'private-setting = "synthetic-private-marker\n';
  await Bun.write(files.codex, malformed);

  const app = await start(files);

  expect(app.status.clients).toMatchObject([
    { client: "codex", state: "failed" },
    { client: "claude", state: "configured" },
  ]);
  expect(await Bun.file(files.codex).text()).toBe(malformed);
  await app.stop();
  expect(await app.logs).not.toContain("synthetic-private-marker");
});

test("serve refuses a symlinked config without placing its token in the target", async () => {
  await using files = await fixture();
  const target = join(files.directory, "managed.toml");
  const original = 'model = "preserve"\n';
  await Bun.write(target, original);
  await mkdir(join(files.directory, ".codex"));
  await symlink(target, files.codex);

  const app = await start(files);

  expect(app.status.clients).toMatchObject([
    { client: "codex", state: "failed" },
    { client: "claude", state: "configured" },
  ]);
  expect((await lstat(files.codex)).isSymbolicLink()).toBe(true);
  expect(await Bun.file(target).text()).toBe(original);
  await app.stop();
});

test("serve refuses a folded config directory without writing into it", async () => {
  await using files = await fixture();
  const target = join(files.directory, "managed-codex");
  await mkdir(target);
  await symlink(target, join(files.directory, ".codex"));

  const app = await start(files);

  expect(app.status.clients).toMatchObject([
    { client: "codex", state: "failed" },
    { client: "claude", state: "configured" },
  ]);
  expect(await Bun.file(join(target, "config.toml")).exists()).toBe(false);
  await app.stop();
});

test("serve refuses credentials in a Git checkout even when the config is not symlinked", async () => {
  await using files = await fixture();
  await mkdir(join(files.directory, ".codex/.git"), { recursive: true });

  const app = await start(files);

  expect(app.status.clients).toMatchObject([
    { client: "codex", state: "failed" },
    { client: "claude", state: "configured" },
  ]);
  expect(await Bun.file(files.codex).exists()).toBe(false);
  await app.stop();
});

test("serve skips absent clients without creating their config directories", async () => {
  await using files = await fixture();

  const app = await start(files, { PATH: "" });

  expect(app.status.clients).toEqual([
    { client: "codex", state: "not-installed" },
    { client: "claude", state: "not-installed" },
  ]);
  expect(await Bun.file(files.codex).exists()).toBe(false);
  expect(await Bun.file(files.claude).exists()).toBe(false);
  await app.stop();
});

test("serve respects native client directory overrides without writing default configs", async () => {
  await using files = await fixture();
  const codex = join(files.directory, "custom-codex");
  const claude = join(files.directory, "custom-claude");

  const app = await start(files, { CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude });

  expect(app.status.clients).toMatchObject([
    { client: "codex", path: join(codex, "config.toml"), state: "configured" },
    { client: "claude", path: join(claude, ".claude.json"), state: "configured" },
  ]);
  expect(await Bun.file(files.codex).exists()).toBe(false);
  expect(await Bun.file(files.claude).exists()).toBe(false);
  await app.stop();
});

test("serve uses the native default user config locations when overrides are empty", async () => {
  await using files = await fixture();

  const app = await start(files, { CODEX_HOME: "", CLAUDE_CONFIG_DIR: "" });

  expect(app.status.clients).toMatchObject([
    { client: "codex", path: files.codex, state: "configured" },
    { client: "claude", path: join(files.directory, ".claude.json"), state: "configured" },
  ]);
  expect(await Bun.file(files.claude).exists()).toBe(false);
  await app.stop();
});

test("serve reports a held registration lock without overwriting the client config", async () => {
  await using files = await fixture();
  const original = 'model = "preserve"\n';
  await Bun.write(files.codex, original);
  await mkdir(files.codex + ".gw.lock");

  const app = await start(files);

  expect(app.status.clients).toMatchObject([
    { client: "codex", state: "failed" },
    { client: "claude", state: "configured" },
  ]);
  expect(await Bun.file(files.codex).text()).toBe(original);
  await app.stop();
});

test("serve reports a client filesystem failure without preventing the other registration", async () => {
  await using files = await fixture();
  await Bun.write(join(files.directory, ".codex"), "not-a-directory");

  const app = await start(files);

  expect(app.status.clients).toMatchObject([
    { client: "codex", state: "failed" },
    { client: "claude", state: "configured" },
  ]);
  expect(await Bun.file(join(files.directory, ".codex")).text()).toBe("not-a-directory");
  await app.stop();
});

test("an unrelated occupied port does not change native registrations", async () => {
  await using files = await fixture();
  const authorizations: (string | null)[] = [];

  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: files.port,
    fetch: (request) => {
      authorizations.push(request.headers.get("authorization"));

      return new Response("unrelated");
    },
  });

  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => listener.stop(true));
  const original = 'model = "preserve"\n';
  await Bun.write(files.codex, original);

  const child = files.spawn(["serve", "--config", files.config]);
  const logs = new Response(child.stderr).text();

  expect(await child.exited).toBe(1);
  expect(await logs).toContain("already in use");
  expect(await Bun.file(files.codex).text()).toBe(original);
  expect(await Bun.file(files.claude).exists()).toBe(false);

  const saved = z
    .object({ version: z.literal(2), key: z.string() })
    .parse(await Bun.file(files.token).json());

  expect(authorizations).toHaveLength(1);
  expect(authorizations[0]).toStartWith("CMG-Status ");
  expect(authorizations[0]).not.toContain(saved.key);
});

test("doctor rejects a forged status without sending its private key or native bearer", async () => {
  await using files = await fixture();
  const app = await start(files);
  const token = await files.readToken();
  const saved = z.object({ key: z.string() }).parse(await Bun.file(files.token).json());
  await app.stop();
  const authorizations: (string | null)[] = [];

  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: files.port,
    fetch: (request) => {
      authorizations.push(request.headers.get("authorization"));

      return Response.json(app.status);
    },
  });

  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => listener.stop(true));
  const child = files.spawn(["doctor", "--config", files.config, "--json"]);
  const output = new Response(child.stdout).text();

  expect(await child.exited).toBe(1);
  expect(await output).toContain("Could not authenticate the local service status");
  expect(authorizations).toHaveLength(1);
  expect(authorizations[0]).toStartWith("CMG-Status ");
  expect(authorizations[0]).not.toContain(token);
  expect(authorizations[0]).not.toContain(saved.key);
});

test("a captured status proof cannot authorize MCP requests after the daemon restarts", async () => {
  await using files = await fixture();
  const first = await start(files);
  await first.stop();
  const authorizations: string[] = [];

  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: files.port,
    fetch: (request) => {
      const authorization = request.headers.get("authorization");
      if (authorization !== null) authorizations.push(authorization);

      return new Response(null, { status: 401 });
    },
  });

  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => listener.stop(true));
  const child = files.spawn(["doctor", "--config", files.config, "--json"]);
  const output = new Response(child.stdout).text();
  expect(await child.exited).toBe(1);
  await output;
  await listener.stop(true);
  const second = await start(files);
  const captured = authorizations[0];
  if (captured === undefined)
    throw new Error("The synthetic listener did not receive a status proof");

  const response = await fetch(`${files.origin}/mcp`, {
    method: "POST",
    headers: { authorization: captured },
  });

  expect(authorizations).toHaveLength(1);
  expect(response.status).toBe(401);
  await second.stop();
});

test("serve replaces a legacy bearer credential only after binding its listener", async () => {
  await using files = await fixture();
  const legacy = "a".repeat(43);
  await mkdir(files.state, { recursive: true, mode: 0o700 });
  await writeFile(files.token, JSON.stringify({ version: 1, token: legacy }), { mode: 0o600 });

  const app = await start(files);

  const saved = z
    .object({ version: z.literal(2), key: z.string() })
    .parse(await Bun.file(files.token).json());

  const response = await fetch(`${files.origin}/status`, {
    headers: { authorization: `Bearer ${legacy}` },
  });

  expect(saved.key).not.toBe(legacy);
  expect(await files.readToken()).not.toBe(legacy);
  expect(response.status).toBe(401);
  await app.stop();
});

test("serve does not upgrade legacy credentials while an unrelated listener owns its port", async () => {
  await using files = await fixture();
  const original = JSON.stringify({ version: 1, token: "a".repeat(43) });
  await mkdir(files.state, { recursive: true, mode: 0o700 });
  await writeFile(files.token, original, { mode: 0o600 });
  const authorizations: (string | null)[] = [];

  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: files.port,
    fetch: (request) => {
      authorizations.push(request.headers.get("authorization"));

      return new Response("unrelated");
    },
  });

  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => listener.stop(true));
  const child = files.spawn(["serve", "--config", files.config]);
  const logs = new Response(child.stderr).text();

  expect(await child.exited).toBe(1);
  expect(await logs).toContain("already in use");
  expect(await Bun.file(files.token).text()).toBe(original);
  expect(authorizations).toEqual([]);
});

test("serve refreshes registrations against the same running daemon without restarting it", async () => {
  await using files = await fixture();
  const app = await start(files);
  await Bun.write(files.codex, 'model = "preserve"\n');

  const child = files.spawn(["serve", "--config", files.config]);
  const logs = new Response(child.stderr).text();

  expect(await child.exited).toBe(0);
  expect(await logs).toContain('"event":"already-running"');
  expect(await files.status()).toMatchObject({
    service: { pid: app.child.pid, instanceId: app.status.service.instanceId },
  });
  expect(
    z.object({ mcp_servers: z.unknown() }).parse(Bun.TOML.parse(await Bun.file(files.codex).text()))
      .mcp_servers,
  ).toMatchObject({ "codemode-mcp-gateway": { url: `${files.origin}/mcp` } });
  await app.stop();
});

test("serve does not reuse a daemon started with different upstream settings", async () => {
  await using files = await fixture();
  const app = await start(files);
  await Bun.write(
    files.config,
    JSON.stringify({
      service: { port: files.port },
      mcp: { servers: { other: { type: "local", command: ["unused"], disabled: true } } },
    }),
  );
  const before = await Bun.file(files.codex).text();

  const child = files.spawn(["serve", "--config", files.config]);
  const logs = new Response(child.stderr).text();

  expect(await child.exited).toBe(1);
  expect(await logs).toContain("already in use");
  expect(await Bun.file(files.codex).text()).toBe(before);
  await app.stop();
});

test("foreground daemon refuses a symlinked credential without modifying its target", async () => {
  await using files = await fixture();
  await mkdir(files.state, { recursive: true });
  const target = join(files.directory, "unrelated.json");
  const content = JSON.stringify({ version: 1, token: "b".repeat(43) });
  await writeFile(target, content, { mode: 0o600 });
  await symlink(target, files.token);

  const child = files.spawn(["serve", "--config", files.config]);
  const stderr = new Response(child.stderr).text();

  expect(await child.exited).toBe(1);
  expect(await stderr).toContain("symlinked service credential");
  expect(await Bun.file(target).text()).toBe(content);
});

test.each([
  {
    name: "malformed",
    content: '{"token":"not-a-valid-service-record"}\n',
    mode: 0o600,
    message: "not rotated",
  },
  {
    name: "world-readable",
    content: JSON.stringify({ version: 1, token: "a".repeat(43) }),
    mode: 0o644,
    message: "private file",
  },
])(
  "foreground daemon refuses $name credentials without replacing them",
  async ({ content, mode, message }) => {
    await using files = await fixture();
    await mkdir(files.state, { recursive: true });
    await writeFile(files.token, content, { mode });
    await chmod(files.token, mode);

    const child = files.spawn(["serve", "--config", files.config]);
    const stderr = new Response(child.stderr).text();

    expect(await child.exited).toBe(1);
    expect(await stderr).toContain(message);
    expect(await Bun.file(files.token).text()).toBe(content);
  },
);

test("foreground HTTP daemon survives stdin EOF and doctor reads its actual status", async () => {
  await using files = await fixture();
  const child = files.spawn(["serve", "--config", files.config]);
  const stderr = new Response(child.stderr).text();
  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");

    const watchdog = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      await child.exited;
    } finally {
      clearTimeout(watchdog);
    }
  });
  const deadline = performance.now() + 5_000;
  while (
    !(await Bun.file(files.codex).exists()) ||
    !(await fetch(`${files.origin}/health`).then(
      (response) => response.ok,
      () => false,
    ))
  ) {
    if (child.exitCode !== null) throw new Error(await stderr);

    if (performance.now() >= deadline) throw new Error("Foreground service did not become ready");

    await Bun.sleep(10);
  }

  const token = await files.readToken();

  expect((await stat(files.token)).mode & 0o777).toBe(0o600);
  expect((await stat(files.state)).mode & 0o777).toBe(0o700);
  await child.stdin.end();

  const response = await fetch(`${files.origin}/status`, {
    headers: { authorization: `Bearer ${token}` },
  });

  const status = z
    .object({ service: z.object({ pid: z.number(), ready: z.boolean() }) })
    .parse(await response.json());

  expect(status.service).toMatchObject({ pid: child.pid, ready: true });

  const diagnostic = join(files.directory, "doctor.json");
  await Bun.write(
    diagnostic,
    JSON.stringify({
      service: { port: files.port },
      mcp: {
        servers: { mustNotStart: { type: "local", command: ["nonexistent-doctor-upstream"] } },
      },
    }),
  );
  const doctor = files.spawn(["doctor", "--config", diagnostic, "--json"]);
  const output = new Response(doctor.stdout).json();
  expect(await doctor.exited).toBe(0);
  expect(await output).toMatchObject({ ok: true, servers: [{ name: "notes", state: "disabled" }] });
  child.kill("SIGTERM");
  expect(await child.exited).toBe(0);
  expect(await stderr).not.toContain(token);
}, 15_000);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gw-daemon-test-"));
  await mkdir(join(directory, "bin"));
  // Discovery probes executability only; these placeholders are never invoked.
  await writeFile(join(directory, "bin/codex"), "", { mode: 0o700 });
  await writeFile(join(directory, "bin/claude"), "", { mode: 0o700 });

  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved"),
  });

  const port = Number(reservation.url.port);
  await reservation.stop(true);
  const config = join(directory, "config.json");
  await Bun.write(
    config,
    JSON.stringify({
      service: { port },
      mcp: { servers: { notes: { type: "local", command: ["unused"], disabled: true } } },
    }),
  );
  const state = join(directory, "codemode-mcp-gateway/service");
  const children = new Set<Bun.Subprocess>();

  return {
    directory,
    config,
    state,
    token: join(state, "auth.json"),
    port,
    origin: `http://127.0.0.1:${port}`,
    codex: join(directory, ".codex/config.toml"),
    claude: join(directory, ".claude/.claude.json"),
    async readToken() {
      const native = z
        .object({
          mcp_servers: z.object({
            "codemode-mcp-gateway": z.object({
              http_headers: z.object({ Authorization: z.string() }),
            }),
          }),
        })
        .parse(Bun.TOML.parse(await Bun.file(join(directory, ".codex/config.toml")).text()));

      const server = native.mcp_servers["codemode-mcp-gateway"];

      return server.http_headers.Authorization.slice(7);
    },
    async status() {
      const child = this.spawn(["doctor", "--config", config, "--json"]);
      const output = new Response(child.stdout).json();
      const error = new Response(child.stderr).text();
      if ((await child.exited) !== 0) throw new Error(await error);

      await error;

      return z
        .object({
          service: z.object({ pid: z.number(), instanceId: z.string() }),
          clients: z.array(z.object({ client: z.string(), state: z.string() }).passthrough()),
        })
        .parse(await output);
    },
    spawn(args: string[], environment: Record<string, string> = {}) {
      const child = Bun.spawn([process.execPath, "--conditions=development", cli, ...args], {
        env: {
          ...process.env,
          HOME: directory,
          CODEX_HOME: join(directory, ".codex"),
          CLAUDE_CONFIG_DIR: join(directory, ".claude"),
          XDG_CONFIG_HOME: join(directory, ".config"),
          XDG_STATE_HOME: directory,
          GW_SERVICE_TOKEN: undefined,
          PATH: join(directory, "bin"),
          ...environment,
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });

      children.add(child);

      return child;
    },
    async [Symbol.asyncDispose]() {
      for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");

      const timer = setTimeout(() => {
        for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
      }, 2_000);

      try {
        await Promise.all([...children].map((child) => child.exited));
      } finally {
        clearTimeout(timer);
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

/** Management runs in-process to intercept launchctl; keep every client/state path private to this test. */
function serviceEnvironment(files: Awaited<ReturnType<typeof fixture>>) {
  const cleanup = new DisposableStack();
  for (const [key, value] of Object.entries({
    HOME: files.directory,
    CODEX_HOME: join(files.directory, ".codex"),
    CLAUDE_CONFIG_DIR: join(files.directory, ".claude"),
    XDG_STATE_HOME: files.directory,
  })) {
    const previous = process.env[key];
    cleanup.defer(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    process.env[key] = value;
  }

  return cleanup;
}

async function start(
  files: Awaited<ReturnType<typeof fixture>>,
  environment: Record<string, string> = {},
  marker = '"event":"listening"',
) {
  const child = files.spawn(["serve", "--config", files.config], environment);
  const ready = Promise.withResolvers<void>();

  const timeout = setTimeout(
    () => ready.reject(new Error("Daemon did not finish client registration")),
    5_000,
  );

  const logs = (async () => {
    let text = "";
    const reader = child.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;

        text += decoder.decode(chunk.value, { stream: true });
        if (text.includes(marker)) ready.resolve();
      }

      ready.reject(new Error("Daemon exited before readiness"));

      return text;
    } finally {
      reader.releaseLock();
    }
  })();

  try {
    await ready.promise;
  } finally {
    clearTimeout(timeout);
  }

  return {
    child,
    logs,
    status: await files.status(),
    async stop() {
      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
      await logs;
    },
  };
}
