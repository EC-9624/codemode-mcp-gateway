import { deepEqual, equal, ok } from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const executable = process.argv[2];
if (executable === undefined) throw new Error("Pass the installed gw executable.");

const home = join(process.cwd(), "service-home");
const token = "synthetic-packed-persistent-token-0123456789";

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
  CODEX_HOME: join(home, ".codex"),
  CLAUDE_CONFIG_DIR: join(home, ".claude"),
  XDG_STATE_HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  PATH: "",
  GW_HTTP_TOKEN: token,
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

const entries = await readdir(home);
equal(entries.includes(".codex"), false);
equal(entries.includes(".claude"), false);
equal(entries.includes("codemode-mcp-gateway"), false);
const client = new Client({ name: "packed-service-consumer", version: "1" });
cleanup.defer(() => client.close());
await client.connect(
  new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }),
);
const result = await client.callTool({ name: "execute", arguments: { code: "return 42;" } });
deepEqual(result.content, [{ type: "text", text: "42" }]);
await client.close();
child.kill("SIGTERM");
equal(await child.exited, 143);
ok(!(await logs).includes(token));
console.log(
  "Installed serve executed over authenticated HTTP without changing client configuration.",
);
