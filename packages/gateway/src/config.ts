import { z } from "zod";
import { SandboxLimits } from "@cmg/codemode";
import { GatewayError } from "./errors.ts";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const stdio = z.strictObject({
  transport: z.literal("stdio").default("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const http = z
  .strictObject({
    id: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional(),
    transport: z.literal("http"),
    url: z.url({ protocol: /^https?$/ }),
    headers: z.record(z.string(), z.string()).optional(),
    auth: z
      .strictObject({
        type: z.literal("oauth"),
        scope: z.string().trim().min(1).optional(),
      })
      .optional(),
  })
  .superRefine((upstream, context) => {
    if (upstream.auth === undefined) return;

    if (upstream.id === undefined) {
      context.addIssue({
        code: "custom",
        path: ["id"],
        message: "OAuth requires a connection id.",
      });
    }

    if (
      Object.keys(upstream.headers ?? {}).some((name) => name.toLowerCase() === "authorization")
    ) {
      context.addIssue({
        code: "custom",
        path: ["headers"],
        message: "OAuth owns the Authorization header.",
      });
    }

    if (!URL.canParse(upstream.url)) return;

    const url = new URL(upstream.url);
    if (
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      (url.protocol !== "https:" && !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))
    ) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "OAuth requires HTTPS or a loopback URL without credentials or a fragment.",
      });
    }
  });

export const UpstreamConfiguration = z.union([stdio, http]);
export type UpstreamConfiguration = z.infer<typeof UpstreamConfiguration>;
export type ServerConfiguration = { upstream: UpstreamConfiguration; disabled: boolean };

const name = z.string().regex(/^[a-zA-Z0-9_-]+$/);

const local = z.strictObject({
  type: z.literal("local"),
  command: z.tuple([z.string().min(1)]).rest(z.string()),
  cwd: z.string().optional(),
  environment: z.record(z.string(), z.string()).optional(),
  disabled: z.boolean().optional(),
});

const remote = z.strictObject({
  type: z.literal("remote"),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  oauth: z
    .union([z.literal(false), z.strictObject({ scope: z.string().trim().min(1).optional() })])
    .optional(),
  disabled: z.boolean().optional(),
});

const servers = z
  .record(name, z.union([local, remote]))
  .refine((value) => Object.keys(value).length > 0, "Configure at least one MCP server.")
  .transform((value, context) => {
    const normalized = new Map<string, ServerConfiguration>();
    for (const [name, server] of Object.entries(value)) {
      const upstream =
        server.type === "local"
          ? {
              transport: "stdio",
              command: server.command[0],
              args: server.command.slice(1),
              ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
              ...(server.environment === undefined ? {} : { env: server.environment }),
            }
          : {
              transport: "http",
              url: server.url,
              ...(server.headers === undefined ? {} : { headers: server.headers }),
              ...(server.oauth === undefined || server.oauth === false
                ? {}
                : {
                    id: name,
                    auth: { type: "oauth", ...server.oauth },
                  }),
            };

      const parsed = UpstreamConfiguration.safeParse(upstream);
      if (!parsed.success) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: parsed.error.issues.map((issue) => issue.message).join(" "),
        });
        continue;
      }

      normalized.set(name, { upstream: parsed.data, disabled: server.disabled ?? false });
    }

    return Object.fromEntries(normalized);
  });

const sandbox = z
  .strictObject({
    timeoutMs: limit(SandboxLimits.timeoutMs).default(5_000),
    totalTimeoutMs: limit(SandboxLimits.totalTimeoutMs).default(10_000),
    memoryLimitBytes: defaultLimit(SandboxLimits.memoryLimitBytes),
    maxStackSizeBytes: defaultLimit(SandboxLimits.maxStackSizeBytes),
    maxSourceBytes: defaultLimit(SandboxLimits.maxSourceBytes),
    maxOutputBytes: defaultLimit(SandboxLimits.maxOutputBytes),
    maxToolCalls: defaultLimit(SandboxLimits.maxToolCalls),
    maxConcurrentToolCalls: defaultLimit(SandboxLimits.maxConcurrentToolCalls),
    maxConcurrentExecutions: defaultLimit(SandboxLimits.maxConcurrentExecutions),
  })
  .prefault({});

/** Both input formats normalize to typed connections; legacy names remain unqualified. */
export const Configuration = z.union([
  z.strictObject({ upstream: UpstreamConfiguration, mcp: z.undefined().optional(), sandbox }),
  z.strictObject({ upstream: z.undefined().optional(), mcp: z.strictObject({ servers }), sandbox }),
]);

export type Configuration = z.infer<typeof Configuration>;
export type ConfigurationInput = z.input<typeof Configuration>;

/** Explicit paths win. XDG paths must be absolute; cwd is never searched implicitly. */
export function configurationPath(
  path?: string,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  if (path !== undefined) return resolve(path);

  const xdg = environment.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg !== "" && !isAbsolute(xdg)) {
    throw new GatewayError("XDG_CONFIG_HOME must be an absolute path.");
  }

  return join(xdg || join(home, ".config"), "cmg", "config.json");
}

/** Resolve login/logout targets without guessing between accounts. */
export function authenticationTarget(
  config: Configuration,
  server?: string,
): UpstreamConfiguration {
  if (config.upstream !== undefined) {
    if (
      server !== undefined &&
      server !== "default" &&
      !("id" in config.upstream && config.upstream.id === server)
    ) {
      throw new GatewayError(`Unknown server ${JSON.stringify(server)}.`);
    }

    return config.upstream;
  }

  if (server !== undefined) {
    const selected = Object.hasOwn(config.mcp.servers, server)
      ? config.mcp.servers[server]
      : undefined;

    if (selected === undefined) throw new GatewayError(`Unknown server ${JSON.stringify(server)}.`);

    return selected.upstream;
  }

  const candidates = Object.values(config.mcp.servers).filter(
    (entry) => entry.upstream.transport === "http" && entry.upstream.auth !== undefined,
  );

  if (candidates.length !== 1 || candidates[0] === undefined) {
    throw new GatewayError("Select an OAuth server with --server <name>.");
  }

  return candidates[0].upstream;
}

/** File parsing is shared by serving and the explicit credential commands. */
export async function readConfiguration(path: string): Promise<Configuration> {
  let input: unknown;
  try {
    input = await Bun.file(path).json();
  } catch (cause) {
    throw new GatewayError(`Could not read configuration JSON at ${path}.`, { cause });
  }

  const parsed = Configuration.safeParse(input);
  if (!parsed.success) throw new GatewayError("Invalid CMG configuration: " + parsed.error.message);

  return parsed.data;
}

/**
 * Expand {env:NAME} from the host environment and validate the resulting HTTP headers.
 * Missing variables or invalid headers return a failure without including credential values.
 */
export function resolveHeaders(
  templates: Readonly<Record<string, string>> = {},
  environment: Readonly<Record<string, string | undefined>> = process.env,
): { ok: true; headers: Headers } | { ok: false; message: string } {
  const headers = new Headers();
  for (const [header, template] of Object.entries(templates)) {
    let missing: string | undefined;

    const value = template.replaceAll(
      /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (_match: string, name: string) => {
        const variable = environment[name];
        if (variable === undefined) missing = name;

        return variable ?? "";
      },
    );

    if (missing !== undefined) {
      return {
        ok: false,
        message: `Missing environment variable ${missing} for upstream header ${JSON.stringify(header)}.`,
      };
    }

    try {
      headers.set(header, value);
    } catch {
      return { ok: false, message: `Invalid HTTP upstream header ${JSON.stringify(header)}.` };
    }
  }

  return { ok: true, headers };
}

function limit(policy: { maximum: number }) {
  return z.number().int().min(1).max(policy.maximum);
}

function defaultLimit(policy: { maximum: number; default: number }) {
  return limit(policy).default(policy.default);
}
