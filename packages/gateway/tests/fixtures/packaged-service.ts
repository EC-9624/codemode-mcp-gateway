import { deepEqual, equal, ok } from "node:assert/strict";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";

const executable = process.argv[2];
if (executable === undefined) throw new Error("Pass the installed gw executable.");

const home = join(process.cwd(), "service-home");
const codex = join(home, ".codex");
const claude = join(home, ".claude");
await mkdir(codex, { recursive: true });
await mkdir(claude, { recursive: true });

const reservation = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response("reserved"),
});

const port = Number(reservation.url.port);
await reservation.stop(true);
const config = join(home, "config.json");
await Bun.write(
  config,
  JSON.stringify({
    service: { port },
    mcp: { servers: { unused: { type: "local", command: ["unused"], disabled: true } } },
  }),
);

const environment = {
  ...process.env,
  HOME: home,
  CODEX_HOME: codex,
  CLAUDE_CONFIG_DIR: claude,
  XDG_STATE_HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  PATH: "",
  GW_SERVICE_TOKEN: undefined,
};

const child = Bun.spawn([process.execPath, executable, "serve", "--config", config], {
  env: environment,
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
});

await using cleanup = new AsyncDisposableStack();
cleanup.defer(async () => {
  if (child.exitCode === null) child.kill("SIGTERM");

  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    await child.exited;
  } finally {
    clearTimeout(timer);
  }
});
const ready = Promise.withResolvers<void>();

const timer = setTimeout(
  () => ready.reject(new Error("Installed service did not become ready")),
  10_000,
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
      if (text.includes('"event":"listening"')) ready.resolve();
    }

    ready.reject(new Error("Installed service exited before readiness"));

    return text;
  } finally {
    reader.releaseLock();
  }
})();

try {
  await ready.promise;
} finally {
  clearTimeout(timer);
}

const codexPath = join(codex, "config.toml");
const claudePath = join(claude, ".claude.json");

const serverMap = z.record(
  z.string(),
  z.object({ url: z.string(), http_headers: z.record(z.string(), z.string()) }),
);

const native = z
  .object({ mcp_servers: serverMap })
  .parse(Bun.TOML.parse(await Bun.file(codexPath).text())).mcp_servers["codemode-mcp-gateway"];

if (native === undefined) throw new Error("Installed serve did not register Codex");

const claudeConfig = z
  .object({
    mcpServers: z.record(
      z.string(),
      z.object({ type: z.string(), url: z.string(), headers: z.record(z.string(), z.string()) }),
    ),
  })
  .parse(await Bun.file(claudePath).json()).mcpServers["codemode-mcp-gateway"];

if (claudeConfig === undefined) throw new Error("Installed serve did not register Claude");

equal(native.url, `http://127.0.0.1:${port}/mcp`);
deepEqual(claudeConfig, { type: "http", url: native.url, headers: native.http_headers });
equal((await stat(codexPath)).mode & 0o777, 0o600);
equal((await stat(claudePath)).mode & 0o777, 0o600);
const client = new Client({ name: "packed-service-consumer", version: "1" });
cleanup.defer(() => client.close());
await client.connect(
  new StreamableHTTPClientTransport(new URL(native.url), {
    requestInit: { headers: native.http_headers },
  }),
);
const result = await client.callTool({ name: "execute", arguments: { code: "return 42;" } });
deepEqual(result.content, [{ type: "text", text: "42" }]);
const inode = (await stat(codexPath)).ino;

const again = Bun.spawn([process.execPath, executable, "serve", "--config", config], {
  env: environment,
  stdout: "pipe",
  stderr: "pipe",
});

const againLogs = new Response(again.stderr).text();
const deadline = setTimeout(() => again.kill("SIGKILL"), 5_000);
try {
  equal(await again.exited, 0);
} finally {
  clearTimeout(deadline);
}

ok((await againLogs).includes('"event":"already-running"'));
equal((await stat(codexPath)).ino, inode);
await client.close();
child.kill("SIGTERM");
equal(await child.exited, 0);
const token = native.http_headers.Authorization?.slice(7);
if (token === undefined) throw new Error("Missing native authentication header");

ok(!(await logs).includes(token));
console.log(
  "Installed serve registered native clients and executed over HTTP without external setup.",
);
