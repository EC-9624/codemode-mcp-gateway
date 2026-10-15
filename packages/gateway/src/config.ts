import { z } from "zod";
import { SandboxLimits } from "@cmg/codemode";
import { GatewayError } from "./errors.ts";

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

/** Transport configuration and fixed sandbox policy; gateway deadlines default to 5 s / 10 s. */
export const Configuration = z.strictObject({
  upstream: z.union([stdio, http]),
  sandbox: z
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
    .prefault({}),
});

export type Configuration = z.infer<typeof Configuration>;

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
