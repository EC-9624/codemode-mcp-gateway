import { z } from "zod";
import { SandboxLimits } from "@cmg/codemode";
import { GatewayError } from "./errors.ts";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const local = z.strictObject({
  type: z.literal("local"),
  command: z.tuple([z.string().min(1)]).rest(z.string()),
  cwd: z.string().optional(),
  environment: z.record(z.string(), z.string()).optional(),
  disabled: z.boolean().default(false),
});

const remote = z
  .strictObject({
    type: z.literal("remote"),
    url: z.url({ protocol: /^https?$/ }),
    headers: z.record(z.string(), z.string()).optional(),
    oauth: z
      .union([z.literal(false), z.strictObject({ scope: z.string().trim().min(1).optional() })])
      .optional(),
    disabled: z.boolean().default(false),
  })
  .superRefine((upstream, context) => {
    if (!upstream.oauth) return;

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

export const ServerConfiguration = z.discriminatedUnion("type", [local, remote]);
export type ServerConfiguration = z.infer<typeof ServerConfiguration>;

const serverEntries = z
  .record(z.string().regex(/^[a-zA-Z0-9_-]+$/), ServerConfiguration)
  .refine((value) => Object.keys(value).length > 0, "Configure at least one MCP server.");

// Zod drops this key before record validation; reject it before parsing can hide an upstream.
const servers = z.preprocess((value: z.input<typeof serverEntries>, context) => {
  if (typeof value === "object" && value !== null && Object.hasOwn(value, "__proto__")) {
    context.addIssue({
      code: "custom",
      path: ["__proto__"],
      message: 'Server name "__proto__" is not supported.',
    });

    return z.NEVER;
  }

  return value;
}, serverEntries);

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

export const Configuration = z.strictObject({ mcp: z.strictObject({ servers }), sandbox });

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
): { name: string; config: ServerConfiguration } {
  if (server !== undefined) return { name: server, config: configuredServer(config, server) };

  const candidates = Object.entries(config.mcp.servers).filter(
    (entry) => entry[1].type === "remote" && entry[1].oauth,
  );

  if (candidates.length !== 1 || candidates[0] === undefined) {
    throw new GatewayError("Select an OAuth server with --server <name>.");
  }

  return { name: candidates[0][0], config: candidates[0][1] };
}

/** Explicit lookup shared by diagnostics and credential commands. */
export function configuredServer(config: Configuration, name: string): ServerConfiguration {
  const selected = Object.hasOwn(config.mcp.servers, name) ? config.mcp.servers[name] : undefined;
  if (selected !== undefined) return selected;

  throw new GatewayError(`Unknown server ${JSON.stringify(name)}.`);
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
        const variable = Object.hasOwn(environment, name) ? environment[name] : undefined;
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
