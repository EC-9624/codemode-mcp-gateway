import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { configurationIdentity, readConfiguration } from "./config.ts";
import { GatewayError } from "./errors.ts";
import { ClientRegistration, reportClients, synchronizeClients } from "./clients.ts";

const label = "dev.codemode-mcp-gateway";

const credential = z.strictObject({
  version: z.literal(1),
  token: z
    .string()
    .length(43)
    .regex(/^[A-Za-z0-9_-]+$/),
});

const upstreamBase = { name: z.string(), updatedAt: z.string() };
export const daemonStatusSchema = z.object({
  service: z.object({
    ready: z.literal(true),
    pid: z.number().int().positive(),
    instanceId: z.uuid(),
    uptimeMs: z.number().nonnegative(),
    configurationId: z.string().optional(),
  }),
  sessions: z.number().int().nonnegative(),
  clients: z.array(ClientRegistration).default([]),
  upstreams: z.array(
    z.discriminatedUnion("state", [
      z.object({
        ...upstreamBase,
        state: z.literal("connected"),
        toolCount: z.number().int().nonnegative(),
      }),
      z.object({ ...upstreamBase, state: z.literal("disabled"), toolCount: z.literal(0) }),
      z.object({ ...upstreamBase, state: z.literal("connecting"), toolCount: z.literal(0) }),
      z.object({
        ...upstreamBase,
        state: z.literal("needs-auth"),
        toolCount: z.literal(0),
        error: z.object({ kind: z.string(), message: z.string() }),
      }),
      z.object({
        ...upstreamBase,
        state: z.literal("failed"),
        toolCount: z.literal(0),
        error: z.object({ kind: z.string(), message: z.string() }),
      }),
    ]),
  ),
});

export function servicePaths() {
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local/state");
  if (!isAbsolute(base)) throw new GatewayError("XDG_STATE_HOME must be absolute.");

  const directory = join(base, "codemode-mcp-gateway", "service");

  return {
    directory,
    token: join(directory, "auth.json"),
    plist: join(homedir(), "Library/LaunchAgents", `${label}.plist`),
  };
}

/** Local endpoint credential, separate from upstream OAuth. Never render this value. */
export async function serviceToken(create = false): Promise<string | undefined> {
  const paths = servicePaths();
  if (create) {
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(paths.directory);
    if (
      directory.isSymbolicLink() ||
      (process.getuid !== undefined && directory.uid !== process.getuid())
    )
      throw new GatewayError(
        "The local service state directory must be owned by this user and must not be a symlink.",
      );

    await chmod(paths.directory, 0o700);
  }

  let file;
  try {
    file = await open(paths.token, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    if (isCode(cause, "ENOENT")) {
      if (!create) return undefined;

      const value = { version: 1, token: randomBytes(32).toString("base64url") };
      try {
        await writeFile(paths.token, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
      } catch (writing) {
        if (!isCode(writing, "EEXIST")) throw writing;
      }

      return serviceToken(false);
    }

    if (isCode(cause, "ELOOP"))
      throw new GatewayError("Refusing a symlinked service credential file.");

    throw cause;
  }

  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && info.uid !== process.getuid())
    )
      throw new GatewayError(
        `Service credentials must be a private file owned by this user. Check permissions on ${paths.token}.`,
      );

    const text = await file.readFile("utf8");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new GatewayError(
        "The service credential file is invalid. Restore it or deliberately reset it while the service is stopped; it was not rotated.",
      );
    }

    const parsed = credential.safeParse(value);
    if (!parsed.success)
      throw new GatewayError("The service credential file is invalid; it was not rotated.");

    return parsed.data.token;
  } finally {
    await file.close();
  }
}

export async function daemonStatus(configuration: string, signal?: AbortSignal) {
  const config = await readConfiguration(configuration);
  const token = await serviceToken();
  if (token === undefined)
    throw new GatewayError("The local service is not prepared. Run gw service install.");

  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${config.service.port}/status`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal:
        signal === undefined
          ? AbortSignal.timeout(2_000)
          : AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
    });
  } catch (cause) {
    throw new GatewayError(
      "The local service is unavailable. Run gw service start, or inspect gw service status and the private service logs.",
      { cause },
    );
  }

  if (response.status === 401)
    throw new GatewayError(
      "The local service rejected its credential. Verify the selected configuration and restart the service; credentials were not rotated.",
    );

  if (!response.ok)
    throw new GatewayError(`Local service status failed with HTTP ${response.status}.`);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new GatewayError("The service port did not return a valid gateway status.", { cause });
  }

  const parsed = daemonStatusSchema.safeParse(payload);
  if (!parsed.success)
    throw new GatewayError("The service port did not return a valid gateway status.");

  return parsed.data;
}

export async function serviceCommand(action: string, configuration: string) {
  if (process.platform !== "darwin")
    throw new GatewayError(
      "Service management currently supports macOS launchd only. Run gw serve in the foreground on other platforms.",
    );

  const uid = process.getuid?.();
  if (uid === undefined)
    throw new GatewayError("Could not determine the current user for launchd.");

  const target = `gui/${uid}/${label}`;
  const paths = servicePaths();
  if (action === "status") {
    const registered = await exists(paths.plist);
    const job = await launchctl(["print", target]);
    const pid = job.stdout.match(/\bpid\s*=\s*(\d+)/)?.[1];

    const endpoint = await daemonStatus(configuration).then(
      (status) => ({ ok: true, status }) as const,
      (cause: unknown) => {
        if (cause instanceof GatewayError) return { ok: false, message: cause.message } as const;

        throw cause;
      },
    );

    return {
      registered,
      running: job.code === 0 && pid !== undefined,
      pid: pid === undefined ? null : Number(pid),
      ready:
        job.code === 0 &&
        pid !== undefined &&
        endpoint.ok &&
        endpoint.status.service.pid === Number(pid),
      endpoint,
    };
  }

  if (!["install", "start", "stop", "restart", "uninstall"].includes(action))
    throw new GatewayError(
      "Unknown service action. Use install, start, stop, restart, status, or uninstall.",
    );

  if (action !== "stop" && action !== "uninstall") await readConfiguration(configuration);

  if (action === "install") {
    await serviceToken(true);
    const bun = join(homedir(), ".bun/bin/bun");

    const cli = join(
      homedir(),
      ".local/share/codemode-mcp-gateway/current/node_modules/codemode-mcp-gateway/dist/cli.js",
    );

    if (!(await exists(bun)) || !(await exists(cli)))
      throw new GatewayError(
        "The installed runtime is missing. Run bun run install:local before installing the service.",
      );

    for (const name of ["stdout.log", "stderr.log"]) {
      const file = await open(
        join(paths.directory, name),
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      );

      try {
        await file.chmod(0o600);
      } finally {
        await file.close();
      }
    }

    const env = {
      HOME: homedir(),
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      XDG_STATE_HOME: process.env.XDG_STATE_HOME || join(homedir(), ".local/state"),
      ...Object.fromEntries(
        ["CODEX_HOME", "CLAUDE_CONFIG_DIR"].flatMap((key) =>
          process.env[key] ? [[key, process.env[key]]] : [],
        ),
      ),
    };

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${[bun, cli, "serve", "--config", configuration].map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(env)
      .map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`)
      .join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>5</integer><key>ExitTimeOut</key><integer>20</integer>
<key>ProcessType</key><string>Background</string>
<key>WorkingDirectory</key><string>${xml(paths.directory)}</string>
<key>StandardOutPath</key><string>${xml(join(paths.directory, "stdout.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(paths.directory, "stderr.log"))}</string>
</dict></plist>\n`;

    await mkdir(join(homedir(), "Library/LaunchAgents"), { recursive: true });

    const existing = await lstat(paths.plist).catch((cause: unknown) => {
      if (isCode(cause, "ENOENT")) return undefined;

      throw cause;
    });

    if (existing?.isSymbolicLink())
      throw new GatewayError("Refusing to replace a symlinked LaunchAgent definition.");

    // Keep a failed write from corrupting the previous service definition.
    const pending = `${paths.plist}.${crypto.randomUUID()}.tmp`;

    const file = await open(
      pending,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );

    try {
      try {
        await file.writeFile(plist);
      } finally {
        await file.close();
      }

      await rename(pending, paths.plist);
    } finally {
      await rm(pending, { force: true });
    }
  }

  const job = await launchctl(["print", target]);
  const loaded = job.code === 0;
  const previousPid = job.stdout.match(/\bpid\s*=\s*(\d+)/)?.[1];
  if (["install", "stop", "restart", "uninstall"].includes(action) && loaded) {
    await checked(["bootout", target]);
    const deadline = performance.now() + 20_000;
    while (previousPid !== undefined && alive(Number(previousPid))) {
      if (performance.now() >= deadline)
        throw new GatewayError(
          "The service did not stop within 20 seconds. Inspect its private logs before restarting.",
        );

      await Bun.sleep(100);
    }
  }

  if (action === "uninstall") await rm(paths.plist, { force: true });

  if (["install", "start", "restart"].includes(action)) {
    if (!(await exists(paths.plist)))
      throw new GatewayError("The service is not installed. Run gw service install.");

    if (action === "start" && loaded && (await ownedReady(configuration, target))) {
      const config = await readConfiguration(configuration);
      const token = await serviceToken();
      if (token === undefined)
        throw new GatewayError("The running service credential is missing; it was not rotated.");

      const clients = await synchronizeClients(
        new URL(`http://127.0.0.1:${config.service.port}/mcp`),
        token,
      );

      reportClients(clients);

      return { action, completed: true, clients };
    }

    if (action === "start" && loaded && previousPid !== undefined)
      throw new GatewayError(
        "The running service is not ready for this configuration/build. Run gw service restart to replace the owned service explicitly.",
      );

    if (action === "start" && loaded) await checked(["kickstart", target]);
    else {
      await checked(["enable", target]);
      await checked(["bootstrap", `gui/${uid}`, paths.plist]);
    }

    const deadline = performance.now() + 20_000;
    while (!(await ownedReady(configuration, target))) {
      if (performance.now() >= deadline) {
        await checked(["bootout", target]);
        throw new GatewayError(
          `The registered service did not become ready and was stopped. Inspect ${join(paths.directory, "stderr.log")}; no upstream login was started.`,
        );
      }

      await Bun.sleep(100);
    }
  }

  return {
    action,
    completed: true,
    ...(["install", "start", "restart"].includes(action)
      ? { clients: (await daemonStatus(configuration)).clients }
      : {}),
  };
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);

    return true;
  } catch (cause) {
    if (isCode(cause, "ESRCH")) return false;

    throw cause;
  }
}

async function ownedReady(configuration: string, target: string) {
  const job = await launchctl(["print", target]);
  const pid = job.stdout.match(/\bpid\s*=\s*(\d+)/)?.[1];
  if (job.code !== 0 || pid === undefined) return false;

  try {
    const config = await readConfiguration(configuration);
    const status = await daemonStatus(configuration);

    return (
      status.service.pid === Number(pid) &&
      status.service.configurationId === configurationIdentity(config, dirname(configuration)) &&
      status.clients.length === 2
    );
  } catch (cause) {
    if (cause instanceof GatewayError) return false;

    throw cause;
  }
}

async function exists(path: string) {
  try {
    await lstat(path);

    return true;
  } catch (cause) {
    if (isCode(cause, "ENOENT")) return false;

    throw cause;
  }
}

function isCode(cause: unknown, code: string) {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

function xml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function launchctl(args: string[]) {
  const child = Bun.spawn(["/bin/launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    return { stdout, stderr, code };
  } finally {
    clearTimeout(timer);
  }
}

async function checked(args: string[]) {
  const result = await launchctl(args);
  if (result.code !== 0)
    throw new GatewayError(
      `launchctl ${args[0]} failed (exit ${result.code}). Inspect gw service status and the private service logs.`,
    );
}
