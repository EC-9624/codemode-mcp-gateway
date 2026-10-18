import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, type ClientOptions } from "@modelcontextprotocol/client";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { type SandboxOptions } from "@codemode-mcp-gateway/codemode";
import { type ConfigurationInput } from "codemode-mcp-gateway";

/** Owns a real CLI process; the watchdog makes shutdown regressions fail instead of hanging. */
export async function gatewayProcess(
  options: {
    mode?: string;
    sandbox?: Omit<SandboxOptions, "tools">;
    client?: ClientOptions;
    upstream?: ConfigurationInput["mcp"]["servers"][string];
    environment?: NodeJS.ProcessEnv;
    entry?: string;
    configuration?: unknown;
    args?: string[];
  } = {},
) {
  await using setup = new AsyncDisposableStack();
  const directory = await mkdtemp(join(tmpdir(), "cmg-server-"));
  setup.defer(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, "config.json");

  await Bun.write(
    config,
    JSON.stringify(
      options.configuration ?? {
        mcp: {
          servers: {
            test: options.upstream ?? {
              type: "local",
              command: [
                process.execPath,
                fileURLToPath(new URL("../fixtures/gateway-upstream.ts", import.meta.url)),
                options.mode ?? "invoke",
              ],
            },
          },
        },
        sandbox: options.sandbox ?? {},
      },
    ),
  );

  const child = spawn(
    process.execPath,
    [
      "--conditions=development",
      options.entry ?? fileURLToPath(new URL("../../src/cli.ts", import.meta.url)),
      ...(options.args ?? ["serve", "--transport", "stdio", "--config", config]),
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.environment },
    },
  );

  const closed = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  child.once("close", (code, signal) => closed.resolve({ code, signal }));
  let stderr = "";
  child.stderr.on("data", (chunk: unknown) => {
    if (!Buffer.isBuffer(chunk)) throw new Error("Expected stderr bytes");

    stderr += chunk.toString("utf8");
  });

  const upstreamPid = () => {
    const match = stderr.match(/upstream-pid:(\d+)/);
    if (match?.[1] === undefined) throw new Error("Upstream PID has not been observed");

    return Number(match[1]);
  };

  const watchdog = setTimeout(() => child.kill("SIGKILL"), 8_000);
  setup.defer(() => clearTimeout(watchdog));
  setup.defer(async () => {
    child.stdin.end();
    await closed.promise;
    const pid = stderr.match(/upstream-pid:(\d+)/)?.[1];
    if (pid === undefined || stderr.includes("upstream-exit")) return;

    // A broken parent cleanup must not leave this test's upstream running.
    try {
      process.kill(Number(pid), "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
    }
  });

  // The JSON-lines transport is symmetric. Owning the process separately lets
  // tests observe natural exit without the SDK client's forced-termination fallback.
  const transport = new StdioServerTransport(child.stdout, child.stdin);
  const client = new Client({ name: "cmg-process-test", version: "1" }, options.client);
  setup.defer(() => client.close());
  const cleanup = setup.move();

  return {
    config,
    client,
    child,
    transport,
    upstreamPid,
    closed: closed.promise,
    get stderr() {
      return stderr;
    },
    async waitFor(marker: string) {
      const signal = AbortSignal.timeout(4_000);
      while (!stderr.includes(marker)) await once(child.stderr, "data", { signal });
    },
    async waitForConnections(count: number) {
      const signal = AbortSignal.timeout(4_000);
      while (stderr.split('"gw.upstream.state":"connected"').length - 1 < count)
        await once(child.stderr, "data", { signal });
    },
    [Symbol.asyncDispose]: () => cleanup.disposeAsync(),
  };
}
