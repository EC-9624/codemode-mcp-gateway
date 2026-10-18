import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { responseText } from "./support/output.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const token = "synthetic-persistent-http-token-0123456789";

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
  await using agent = await connect(files);

  const response = await agent.client.callTool({
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

test("the supplied HTTP token remains usable across process restarts", async () => {
  await using files = await fixture();
  const first = await start(files);
  await first.stop();

  const second = await start(files);
  await using agent = await connect(files);

  const response = await agent.client.callTool({
    name: "execute",
    arguments: { code: "return 42;" },
  });

  expect(second.status.service.instanceId).not.toBe(first.status.service.instanceId);
  expect(response.content).toEqual([{ type: "text", text: "42" }]);
  await second.stop();
  expect(await second.logs).not.toContain(token);
});

test("HTTP serving and live doctor use the private token file without an environment variable", async () => {
  await using files = await fixture();
  const directory = join(files.directory, "codemode-mcp-gateway");
  await mkdir(directory, { mode: 0o700 });
  const path = join(directory, "token");
  await Bun.write(path, token + "\n");
  await chmod(path, 0o600);

  const first = await start(files, { GW_HTTP_TOKEN: undefined });
  await first.stop();
  const second = await start(files, { GW_HTTP_TOKEN: undefined });
  await using agent = await connect(files);

  expect(
    (await agent.client.callTool({ name: "execute", arguments: { code: "return 42;" } })).content,
  ).toEqual([{ type: "text", text: "42" }]);

  const doctor = files.spawn(["doctor", "--config", files.config, "--json"], {
    GW_HTTP_TOKEN: undefined,
  });

  const output = new Response(doctor.stdout).json();
  expect(await doctor.exited).toBe(0);
  expect(await output).toMatchObject({ ok: true, service: { pid: second.child.pid } });
  expect(await Bun.file(path).text()).toBe(token + "\n");
  await second.stop();
});

test("explicit token rotation rejects the previous token after restart", async () => {
  await using files = await fixture();
  const first = await start(files);
  await first.stop();
  const replacement = "synthetic-replacement-http-token-9876543210";
  const second = await start(files, { GW_HTTP_TOKEN: replacement });

  const rejected = await fetch(`${files.origin}/status`, {
    headers: { authorization: `Bearer ${token}` },
  });

  const accepted = await fetch(`${files.origin}/status`, {
    headers: { authorization: `Bearer ${replacement}` },
  });

  expect(rejected.status).toBe(401);
  expect(accepted.status).toBe(200);
  await second.stop();
  expect(await second.logs).not.toContain(replacement);
});

test("HTTP serving leaves user client configs and legacy service credentials untouched", async () => {
  await using files = await fixture();
  const codex = join(files.directory, ".codex/config.toml");
  const claude = join(files.directory, ".claude/.claude.json");
  const legacy = join(files.directory, "codemode-mcp-gateway/service/auth.json");
  await Bun.write(codex, "malformed user-owned TOML\n");
  await Bun.write(claude, "malformed user-owned JSON\n");
  await Bun.write(legacy, "legacy user-owned credential\n");

  const app = await start(files);

  expect(app.status).not.toHaveProperty("clients");
  expect(app.status.service).not.toHaveProperty("configurationId");
  expect(await Bun.file(codex).text()).toBe("malformed user-owned TOML\n");
  expect(await Bun.file(claude).text()).toBe("malformed user-owned JSON\n");
  expect(await Bun.file(legacy).text()).toBe("legacy user-owned credential\n");
  await app.stop();
});

test("HTTP serving needs no installed clients and creates no client or service-state directories", async () => {
  await using files = await fixture();

  const app = await start(files);
  await app.stop();

  const entries = await readdir(files.directory);
  expect(entries).not.toContain(".codex");
  expect(entries).not.toContain(".claude");
  expect(entries).not.toContain("codemode-mcp-gateway");
});

test.each([
  {
    name: "missing",
    value: undefined,
    message: "No HTTP token is configured. Run gw setup or set GW_HTTP_TOKEN.\n",
  },
  { name: "empty", value: "" },
  { name: "short", value: "synthetic-secret-too-short" },
  { name: "oversized", value: "x".repeat(257) },
  { name: "invalid characters", value: "synthetic-private-token-with-a space" },
])("HTTP serving refuses a $name token without creating state", async ({ value, message }) => {
  await using files = await fixture();
  const child = files.spawn(["serve", "--config", files.config], { GW_HTTP_TOKEN: value });
  const logs = new Response(child.stderr).text();
  const output = new Response(child.stdout).text();

  expect(await child.exited).toBe(1);
  expect(await logs).toBe(
    message ??
      "GW_HTTP_TOKEN must contain 32–256 letters, digits, underscores, or hyphens. Unset it to use the setup-created token file.\n",
  );
  expect(await output).toBe("");
  expect(await readdir(files.directory)).not.toContain("codemode-mcp-gateway");
});

test("an occupied port fails without probing its owner or starting upstream connections", async () => {
  await using files = await fixture();
  const requests: Request[] = [];

  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: files.port,
    fetch: (request) => {
      requests.push(request);

      return new Response("unrelated");
    },
  });

  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => listener.stop(true));
  await Bun.write(
    files.config,
    JSON.stringify({
      service: { port: files.port },
      mcp: { servers: { mustNotStart: { type: "local", command: ["nonexistent-upstream"] } } },
    }),
  );
  const child = files.spawn(["serve", "--config", files.config]);
  const logs = new Response(child.stderr).text();

  expect(await child.exited).toBe(1);
  expect(await logs).toContain("already in use");
  expect(await logs).not.toContain('"state":"connecting"');
  expect(await logs).not.toContain(token);
  expect(requests).toHaveLength(0);
});

test("a second serve fails instead of adopting the running gateway", async () => {
  await using files = await fixture();
  const app = await start(files);

  const child = files.spawn(["serve", "--config", files.config]);
  const logs = new Response(child.stderr).text();

  expect(await child.exited).toBe(1);
  expect(await logs).toContain("already in use");
  expect((await files.status()).service.pid).toBe(app.child.pid);
  await app.stop();
});

test("foreground HTTP serving survives stdin EOF and doctor reads its actual upstream status", async () => {
  await using files = await fixture();
  const app = await start(files);
  await app.child.stdin.end();
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
  const diagnostics = new Response(doctor.stderr).text();

  expect(await doctor.exited).toBe(0);
  expect(await output).toMatchObject({
    ok: true,
    service: { ready: true, pid: app.child.pid },
    servers: [{ name: "notes", state: "disabled" }],
  });
  expect(await diagnostics).toBe("");
  await app.stop();
});

test("doctor reports a mismatched persistent token without displaying it", async () => {
  await using files = await fixture();
  const app = await start(files);

  const doctor = files.spawn(["doctor", "--config", files.config, "--json"], {
    GW_HTTP_TOKEN: "synthetic-wrong-http-token-9876543210",
  });

  const output = new Response(doctor.stdout).json();

  expect(await doctor.exited).toBe(1);
  expect(await output).toEqual({
    ok: false,
    error: {
      message:
        "The local gateway rejected GW_HTTP_TOKEN. Use the same token as the running gateway.",
    },
  });
  await app.stop();
});

test("doctor rejects a locally configured server absent from the running service", async () => {
  await using files = await fixture();
  const app = await start(files);
  const diagnostic = join(files.directory, "doctor.json");
  await Bun.write(
    diagnostic,
    JSON.stringify({
      service: { port: files.port },
      mcp: { servers: { absent: { type: "local", command: ["unused"], disabled: true } } },
    }),
  );

  const doctor = files.spawn(["doctor", "--config", diagnostic, "--server", "absent", "--json"]);
  const output = new Response(doctor.stdout).json();
  const diagnostics = new Response(doctor.stderr).text();

  expect(await doctor.exited).toBe(1);
  expect(await output).toEqual({
    ok: false,
    error: { message: 'Unknown server "absent" in the running gateway.' },
  });
  expect(await diagnostics).toBe("");
  await app.stop();
});

test("doctor selects a running server even when absent from local configuration", async () => {
  await using files = await fixture();
  const app = await start(files);
  const diagnostic = join(files.directory, "doctor.json");
  await Bun.write(
    diagnostic,
    JSON.stringify({
      service: { port: files.port },
      mcp: { servers: { localOnly: { type: "local", command: ["unused"], disabled: true } } },
    }),
  );

  const doctor = files.spawn(["doctor", "--config", diagnostic, "--server", "notes", "--json"]);
  const output = new Response(doctor.stdout).json();
  const diagnostics = new Response(doctor.stderr).text();

  expect(await doctor.exited).toBe(0);
  expect(await output).toMatchObject({
    ok: true,
    servers: [{ name: "notes", state: "disabled" }],
    service: { pid: app.child.pid },
  });
  expect(await diagnostics).toBe("");
  await app.stop();
});

test("doctor never forwards the persistent token to a redirected endpoint", async () => {
  await using files = await fixture();
  const requests: Request[] = [];

  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      requests.push(request);

      return new Response("must not be contacted");
    },
  });

  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => target.stop(true));

  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: files.port,
    fetch: () => Response.redirect(target.url.href, 302),
  });

  cleanup.defer(() => listener.stop(true));
  const doctor = files.spawn(["doctor", "--config", files.config, "--json"]);
  const output = new Response(doctor.stdout).text();

  expect(await doctor.exited).toBe(1);
  expect(await output).toContain("redirects are not followed");
  expect(await output).not.toContain(token);
  expect(requests).toHaveLength(0);
});

test.each([
  { name: "malformed JSON", body: "private-upstream-response" },
  { name: "an invalid status shape", body: '{"private":"upstream-response"}' },
])("doctor rejects $name without displaying response data", async ({ body }) => {
  await using files = await fixture();

  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: files.port,
    fetch: () => new Response(body),
  });

  await using cleanup = new AsyncDisposableStack();
  cleanup.defer(() => listener.stop(true));
  const doctor = files.spawn(["doctor", "--config", files.config, "--json"]);
  const output = new Response(doctor.stdout).json();

  expect(await doctor.exited).toBe(1);
  expect(await output).toEqual({
    ok: false,
    error: { message: "The service port did not return a valid gateway status." },
  });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gw-http-cli-"));

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
  const children = new Set<Bun.Subprocess>();

  return {
    directory,
    config,
    port,
    origin: `http://127.0.0.1:${port}`,
    async status(bearer = token) {
      const response = await fetch(`http://127.0.0.1:${port}/status`, {
        headers: { authorization: `Bearer ${bearer}` },
      });

      return z
        .object({
          service: z.object({ pid: z.number(), instanceId: z.uuid() }).passthrough(),
        })
        .passthrough()
        .parse(await response.json());
    },
    spawn(args: string[], environment: NodeJS.ProcessEnv = {}) {
      const child = Bun.spawn([process.execPath, "--conditions=development", cli, ...args], {
        env: {
          ...process.env,
          HOME: directory,
          CODEX_HOME: join(directory, ".codex"),
          CLAUDE_CONFIG_DIR: join(directory, ".claude"),
          XDG_CONFIG_HOME: join(directory, ".config"),
          XDG_STATE_HOME: directory,
          GW_HTTP_TOKEN: token,
          PATH: "",
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

async function start(
  files: Awaited<ReturnType<typeof fixture>>,
  environment: NodeJS.ProcessEnv = {},
  marker = '"event":"listening"',
) {
  const child = files.spawn(["serve", "--config", files.config], environment);
  const ready = Promise.withResolvers<void>();

  const timeout = setTimeout(
    () => ready.reject(new Error("HTTP gateway did not become ready")),
    5_000,
  );

  const logs = (async () => {
    let text = "";
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) {
      text += decoder.decode(chunk, { stream: true });
      if (text.includes(marker)) ready.resolve();
    }

    ready.reject(new Error("HTTP gateway exited before readiness"));

    return text;
  })();

  try {
    await ready.promise;
  } finally {
    clearTimeout(timeout);
  }

  return {
    child,
    logs,
    status: await files.status(environment.GW_HTTP_TOKEN ?? token),
    async stop() {
      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
      await logs;
    },
  };
}

async function connect(files: Awaited<ReturnType<typeof fixture>>) {
  const client = new Client({ name: "http-cli-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${files.origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );

  return {
    client,
    [Symbol.asyncDispose]: () => client.close(),
  };
}
