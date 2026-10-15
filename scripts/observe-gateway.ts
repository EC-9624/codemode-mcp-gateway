import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";

const args = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { gateway: { type: "string" } },
});

const [configuration, output] = args.positionals;
const gateway = args.values.gateway;
if (
  args.positionals.length !== 2 ||
  configuration === undefined ||
  output === undefined ||
  (gateway !== undefined && !gateway.trim())
) {
  console.error(
    "Usage: bun scripts/observe-gateway.ts <gateway-config> <metadata-jsonl> [--gateway <installed-cmg-path>]",
  );
  process.exit(1);
}

const request = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.literal("tools/call"),
  params: z.object({
    name: z.literal("execute"),
    _meta: z.object({ "ai.opencode/sessionID": z.string().optional() }).optional(),
  }),
});

const response = z.object({
  id: z.union([z.string(), z.number()]),
  result: z
    .object({
      isError: z.boolean().optional(),
      structuredContent: z
        .object({
          result: z.discriminatedUnion("ok", [
            z.object({ ok: z.literal(true) }),
            z.object({
              ok: z.literal(false),
              error: z.object({ kind: z.string(), resource: z.string().optional() }),
            }),
          ]),
          calls: z.array(z.object({ status: z.string() })),
        })
        .optional(),
    })
    .optional(),
  error: z.object({ code: z.number() }).optional(),
});

const pending = new Map<string | number, { started: number; session: string | undefined }>();
const logPath = resolve(output);

const child = spawn(
  gateway === undefined ? process.execPath : resolve(gateway),
  gateway === undefined
    ? [
        "--conditions=development",
        fileURLToPath(new URL("../packages/gateway/src/cli.ts", import.meta.url)),
        resolve(configuration),
      ]
    : [resolve(configuration)],
  { stdio: ["pipe", "pipe", "inherit"] },
);

const closed = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
child.once("close", (code, signal) => closed.resolve({ code, signal }));
child.once("error", () => {
  record({ event: "spawn-failed" });
  process.exitCode = 1;
});
record({ event: "started" });

using cleanup = new DisposableStack();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  const stop = () => {
    child.kill(signal);
  };

  process.on(signal, stop);
  cleanup.defer(() => process.off(signal, stop));
}

const input = createInterface({ input: process.stdin });
const replies = createInterface({ input: child.stdout });
cleanup.defer(() => {
  input.close();
  replies.close();
});
input.on("line", (line) => {
  const parsed = request.safeParse(json(line));
  if (!parsed.success) return;

  const { id, params } = parsed.data;
  const session = params._meta?.["ai.opencode/sessionID"];
  pending.set(id, { started: performance.now(), session });
  record({ event: "request", id, session, inFlight: pending.size });
});
replies.on("line", (line) => {
  const parsed = response.safeParse(json(line));
  if (!parsed.success) return;

  const { id, result, error } = parsed.data;
  const call = pending.get(id);
  if (call === undefined) return;

  pending.delete(id);
  const report = result?.structuredContent;
  record({
    event: "response",
    id,
    session: call.session,
    elapsedMs: performance.now() - call.started,
    inFlight: pending.size,
    isError: result?.isError,
    protocolErrorCode: error?.code,
    ok: report?.result.ok,
    failure: report?.result.ok === false ? report.result.error : undefined,
    toolCalls: report?.calls.length,
  });
});

// Observe copies of newline-delimited frames; forward the original bytes without rewriting MCP.
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout, { end: false });
child.stdin.on("error", () => record({ event: "input-closed" }));
const exit = await closed.promise;
process.stdin.unpipe(child.stdin);
process.stdin.pause();
record({ event: "closed", ...exit, pending: pending.size });
process.exitCode = exit.code ?? 1;

function record(fields: Record<string, unknown>) {
  appendFileSync(
    logPath,
    JSON.stringify({
      time: new Date().toISOString(),
      observerPid: process.pid,
      gatewayPid: child.pid,
      ...fields,
    }) + "\n",
  );
}

function json(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    // The actual MCP peer owns protocol errors; the observer must not reinterpret a bad frame.
    return undefined;
  }
}
