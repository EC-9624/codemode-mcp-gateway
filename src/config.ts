import { z } from "zod";
import { SandboxLimits } from "./codemode";

const stdio = z.strictObject({
  transport: z.literal("stdio").default("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const http = z.strictObject({
  transport: z.literal("http"),
  url: z.url({ protocol: /^https?$/ }),
  headers: z.record(z.string(), z.string()).optional(),
});

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
    })
    .prefault({}),
});

export type Configuration = z.infer<typeof Configuration>;

/** Resolve host-owned header templates without including credential values in diagnostics. */
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
