import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";

await using cleanup = new AsyncDisposableStack();
const directory = await mkdtemp(join(tmpdir(), "gw-standalone-"));
cleanup.defer(() => rm(directory, { recursive: true, force: true }));
const binary = join(directory, "gw");
await copyFile(process.argv[2] ?? fileURLToPath(new URL("../dist/gw", import.meta.url)), binary);

const environment = {
  HOME: directory,
  XDG_CONFIG_HOME: join(directory, "config"),
  XDG_STATE_HOME: join(directory, "state"),
  PATH: "",
};

// Downloaded applications must not auto-load an unrelated project's runtime config.
await Bun.write(join(directory, ".env"), "GW_HTTP_TOKEN=invalid-cwd-token\n");
await Bun.write(join(directory, "bunfig.toml"), 'preload = ["./must-not-load.ts"]\n');

const manifest = z
  .object({ version: z.string() })
  .parse(await Bun.file(new URL("../packages/gateway/package.json", import.meta.url)).json());

deepEqual(await run(["--version"]), { code: 0, stdout: `gw ${manifest.version}\n`, stderr: "" });
equal((await run(["--help"])).code, 0);
const prepared = await run(["setup"]);
equal(prepared.code, 0);
equal(prepared.stderr, "");
ok(prepared.stdout.includes("Configuration is not ready"));
const tokenFile = join(environment.XDG_STATE_HOME, "codemode-mcp-gateway/token");
const token = (await Bun.file(tokenFile).text()).trim();
ok(/^[a-f0-9]{64}$/.test(token));
equal((await stat(tokenFile)).mode & 0o777, 0o600);
ok(!prepared.stdout.includes(token));
deepEqual(await run(["token"]), { code: 0, stdout: token + "\n", stderr: "" });
equal((await run(["setup"])).code, 0);
equal((await Bun.file(tokenFile).text()).trim(), token);

const started = Promise.withResolvers<void>();
const cancelled = Promise.withResolvers<void>();
const upstream = new McpServer({ name: "standalone-upstream", version: "1" });
upstream.registerTool(
  "add",
  { inputSchema: z.object({ a: z.number(), b: z.number() }) },
  ({ a, b }) => ({
    content: [{ type: "text", text: String(a + b) }],
  }),
);
upstream.registerTool("wait", { inputSchema: z.object({}) }, async (_args, { mcpReq }) => {
  const abort = () => cancelled.resolve();
  mcpReq.signal.addEventListener("abort", abort, { once: true });
  if (mcpReq.signal.aborted) abort();

  started.resolve();
  try {
    await cancelled.promise;

    return { content: [] };
  } finally {
    mcpReq.signal.removeEventListener("abort", abort);
  }
});

const wire = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: () => crypto.randomUUID(),
});

await upstream.connect(wire);

const listener = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  fetch: (request) => wire.handleRequest(request),
});

cleanup.defer(async () => {
  cancelled.resolve();
  await upstream.close();
  await listener.stop(true);
});

const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = Number(reservation.url.port);
await reservation.stop(true);
const config = join(environment.XDG_CONFIG_HOME, "codemode-mcp-gateway/config.json");
await Bun.write(
  config,
  JSON.stringify({
    service: { port },
    mcp: { servers: { math: { type: "remote", url: listener.url.href } } },
    sandbox: { timeoutMs: 100 },
  }),
);

const child = Bun.spawn([binary, "serve"], {
  cwd: directory,
  env: environment,
  stdout: "pipe",
  stderr: "pipe",
});

cleanup.defer(async () => {
  if (child.exitCode === null) child.kill("SIGTERM");

  const deadline = setTimeout(() => child.kill("SIGKILL"), 2_000);
  try {
    await child.exited;
  } finally {
    clearTimeout(deadline);
  }
});
const ready = Promise.withResolvers<void>();

const diagnostics = (async () => {
  let text = "";
  const decoder = new TextDecoder();
  for await (const chunk of child.stderr) {
    text += decoder.decode(chunk, { stream: true });
    if (text.includes('"state":"connected"')) ready.resolve();
  }

  ready.reject(new Error(`Standalone gateway exited before readiness: ${text}`));

  return text;
})();

await bounded(ready.promise, "Standalone gateway did not connect its upstream.");
equal((await run(["doctor", "--json"])).code, 0);

const agent = new Client({ name: "standalone-http-probe", version: "1" });
cleanup.defer(() => agent.close());
await agent.connect(
  new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }),
);
deepEqual(
  await agent.callTool({
    name: "execute",
    arguments: { code: 'return (await tools["math.add"]({ a: 20, b: 22 })).content[0].text;' },
  }),
  { content: [{ type: "text", text: "42" }] },
);
const timedOut = await agent.callTool({ name: "execute", arguments: { code: "while (true) {}" } });
equal(timedOut.isError, true);
ok(JSON.stringify(timedOut).includes("Execution exceeded"));
const controller = new AbortController();

const pending = agent.callTool(
  {
    name: "execute",
    arguments: { code: 'return await tools["math.wait"]({});' },
  },
  { signal: controller.signal },
);

const rejected = rejects(pending);
await bounded(started.promise, "Standalone upstream call did not start.");
controller.abort();
await rejected;
await bounded(cancelled.promise, "Standalone cancellation did not reach the upstream.");
deepEqual(await agent.callTool({ name: "execute", arguments: { code: "return 43;" } }), {
  content: [{ type: "text", text: "43" }],
});
await agent.close();
child.kill("SIGTERM");
equal(await bounded(child.exited, "Standalone HTTP process did not shut down."), 0);
ok(!(await diagnostics).includes(token));
equal(await new Response(child.stdout).text(), "");

const stdioConfig = join(directory, "stdio.json");
await Bun.write(
  stdioConfig,
  JSON.stringify({
    mcp: { servers: { unused: { type: "local", command: ["unused"], disabled: true } } },
  }),
);
const stdio = new Client({ name: "standalone-stdio-probe", version: "1" });

const transport = new StdioClientTransport({
  command: binary,
  args: ["serve", "--stdio", "--config", stdioConfig],
  cwd: directory,
  env: { ...environment, GW_HTTP_TOKEN: "invalid-but-unused-in-stdio" },
  stderr: "pipe",
});

cleanup.defer(() => stdio.close());
await stdio.connect(transport);
deepEqual(await stdio.callTool({ name: "execute", arguments: { code: "return 44;" } }), {
  content: [{ type: "text", text: "44" }],
});
await stdio.close();
console.log(
  "Standalone gw verified: setup, private token, embedded version/WASM/workers, host calls, timeout/recovery, cancellation, HTTP, and stdio with an empty PATH outside the checkout.",
);

async function run(args: string[]) {
  const child = Bun.spawn([binary, ...args], {
    cwd: directory,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });

  const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    return { code, stdout, stderr };
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

async function bounded<T>(promise: Promise<T>, message: string): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error(message)), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}
