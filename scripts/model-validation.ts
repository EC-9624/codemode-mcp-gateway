import { ok, strictEqual } from "node:assert";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

strictEqual(
  process.argv[2],
  "--approve-model-calls",
  "Usage: bun run validate:models --approve-model-calls (four paid model sessions)",
);
strictEqual(process.argv.length, 3);
const root = fileURLToPath(new URL("../", import.meta.url));
const workflows = ["alpha", "bravo", "charlie", "delta"];
const model = { providerID: "openai", id: "gpt-6.1-sol-fast" };
const started = performance.now();
await using cleanup = new AsyncDisposableStack();
const directory = await realpath(await mkdtemp(join(tmpdir(), "cmg-model-validation-")));
let passed = false;
cleanup.defer(async () => {
  if (passed) await rm(directory, { recursive: true, force: true });
  else emit("evidence-retained", { directory });
});
const observer = join(directory, "gateway.jsonl");
const audit = join(directory, "upstream.jsonl");
const configuration = join(directory, "gateway.json");

// Keep provider setup, but explicitly disable inherited MCP entries so
// the validation sessions cannot accidentally call a user's real upstreams.
const entries = z
  .array(
    z.object({
      type: z.string(),
      info: z
        .object({
          mcp: z.object({ servers: z.record(z.string(), z.unknown()).optional() }).optional(),
        })
        .optional(),
    }),
  )
  .parse(await api("get", "/api/config", undefined, 30_000, root));

const inherited = entries.flatMap((entry) => Object.keys(entry.info?.mcp?.servers ?? {}));

const permissions = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "cmg_execute", resource: "*", effect: "allow" },
  { action: "read", resource: `${directory}/*`, effect: "allow" },
  { action: "read", resource: "cmg-output-*/*", effect: "allow" },
];

await Bun.write(
  configuration,
  JSON.stringify({
    mcp: {
      servers: {
        documents: {
          type: "local",
          command: [
            process.execPath,
            join(root, "scripts/fixtures/model-validation-upstream.ts"),
            audit,
          ],
        },
      },
    },
    sandbox: { timeoutMs: 120_000, totalTimeoutMs: 180_000, maxConcurrentExecutions: 4 },
  }),
);
await Bun.write(
  join(directory, "opencode.json"),
  JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    snapshots: false,
    warming: false,
    agents: {
      "gateway-validation": {
        mode: "primary",
        steps: 12,
        permissions,
        system:
          "Complete only the synthetic gateway-validation task. Never edit files, use external services, or launch subagents. Use cmg_execute for gateway calls and native read for its saved files. Do not replay operations after a failure. Keep discovery and schema responses compact.",
      },
    },
    mcp: {
      servers: {
        ...Object.fromEntries(
          inherited.map((name) => [name, { type: "local", command: ["false"], disabled: true }]),
        ),
        cmg: {
          type: "local",
          codemode: false,
          protocol: "legacy",
          cwd: root,
          environment: { TMPDIR: directory },
          command: [
            process.execPath,
            join(root, "scripts/observe-gateway.ts"),
            configuration,
            observer,
          ],
        },
      },
    },
  }),
);
const location = `?location[directory]=${encodeURIComponent(directory)}`;
const sessions: string[] = [];
const saved = new Set<string>();
let disconnected = false;
async function disconnect() {
  if (disconnected) return;

  // Interrupt only this run's sessions; never stop or reload the shared service.
  await Promise.all(sessions.map((id) => api("post", `/api/session/${id}/interrupt`)));
  await api("post", `/api/experimental/mcp/cmg/disconnect${location}`);
  disconnected = true;
}

cleanup.defer(disconnect);
const info = z.object({ version: z.string() }).parse(await api("get", "/api/info"));
emit("environment", { opencode: info.version, bun: Bun.version, model, workflows: 4 });

const discovered = z
  .array(
    z.object({
      type: z.string(),
      path: z.string().optional(),
      info: z
        .object({
          mcp: z.object({ servers: z.record(z.string(), z.unknown()).optional() }).optional(),
        })
        .optional(),
    }),
  )
  .parse(await api("get", `/api/config${location}`));

ok(
  discovered.some(
    (entry) =>
      entry.path === join(directory, "opencode.json") &&
      entry.info?.mcp?.servers?.cmg !== undefined,
  ),
);

const serversSchema = z.object({
  location: z.object({ directory: z.string() }),
  data: z.array(z.object({ name: z.string(), status: z.object({ status: z.string() }) })),
});

const connectingDeadline = performance.now() + 20_000;
let servers = serversSchema.parse(await api("get", `/api/mcp${location}`));
while (servers.data.find((server) => server.name === "cmg")?.status.status !== "connected") {
  ok(performance.now() < connectingDeadline, "Synthetic MCP did not connect within 20 seconds");
  await Bun.sleep(100);
  servers = serversSchema.parse(await api("get", `/api/mcp${location}`));
}

strictEqual(servers.data.find((server) => server.name === "cmg")?.status.status, "connected");
ok(servers.data.every((server) => server.name === "cmg" || server.status.status === "disabled"));
emit("servers", { syntheticOnly: true });

const admitted = await Promise.allSettled(
  workflows.map(async (workflow) => {
    const created = z.object({ data: z.object({ id: z.string() }) }).parse(
      await api("post", "/api/session", {
        title: `CMG synthetic validation: ${workflow}`,
        agent: "gateway-validation",
        model,
        location: { directory },
        permissions,
      }),
    );

    sessions.push(created.data.id);
    emit("session-created", { workflow, session: created.data.id });
    await api("post", `/api/session/${created.data.id}/prompt`, {
      text: `You are workflow ${workflow} in an approved four-agent synthetic local validation.
Use only cmg_execute and native read. Discover search, fetch, unavailable tools and inspect their schemas; do not guess tool signatures. Return compact discovery/schema details.
Call the document search once for your workflow (${workflow}); other agents must arrive before it returns. Do not impose your own timeout or retry. Parse its text JSON for id and verificationLine.
Fetch that id exactly once through execute, returning the complete document text string, not an MCP envelope or a projection. This must produce a saved-output path. Use native read on that path at verificationLine to retrieve the verification record hidden outside the preview. Do not fetch again or reconstruct a document.
Call unavailable exactly once for your workflow. Surface its public failure through execute by throwing Error with the returned public error text; do not retry or substitute a success.
Finally reply with the exact verification record, document start/end markers, and the actionable public error. No files may be edited. Do not use real upstreams or other agents.`,
    });
  }),
);

for (const result of admitted) {
  if (result.status === "rejected") throw result.reason;
}

const finished = await Promise.allSettled(
  sessions.map((id) => api("post", `/api/experimental/session/${id}/wait`, undefined, 240_000)),
);

for (const result of finished) {
  if (result.status === "rejected") throw result.reason;
}

const messagesSchema = z.object({
  data: z.array(
    z.object({
      type: z.string(),
      model: z.object({ providerID: z.string(), id: z.string() }).optional(),
      finish: z.string().optional(),
      error: z.unknown().optional(),
      content: z
        .array(
          z.object({
            type: z.string(),
            text: z.string().optional(),
            name: z.string().optional(),
            state: z.unknown().optional(),
          }),
        )
        .optional(),
    }),
  ),
});

for (const id of sessions) {
  const messages = messagesSchema.parse(await api("get", `/api/session/${id}/message?limit=100`));
  const assistants = messages.data.filter((message) => message.type === "assistant");
  ok(assistants.length > 0);
  ok(
    assistants.every(
      (message) =>
        message.error === undefined &&
        message.model?.providerID === model.providerID &&
        message.model.id === model.id,
    ),
  );
  const content = assistants.flatMap((message) => message.content ?? []);

  const tools = content
    .filter((part) => part.type === "tool")
    .map((part) => ({
      ...part,
      state: z
        .object({
          status: z.enum(["completed", "error"]),
          input: z.record(z.string(), z.unknown()),
          content: z.array(z.object({ text: z.string().optional() })).optional(),
        })
        .parse(part.state),
    }));

  const replies = tools
    .flatMap((part) => part.state?.content ?? [])
    .map((part) => part.text ?? "")
    .join("\n");

  const paths = [...replies.matchAll(/\[Full output: (.+)\]/g)].map((match) => match[1]);
  strictEqual(paths.length, 1, "Expected one gateway spill, without replay");
  const path = paths[0];
  ok(path);
  ok(path.startsWith(`${directory}/cmg-output-`));
  saved.add(path);
  const full = await Bun.file(path).text();
  const proof = full.match(/verification:(alpha|bravo|charlie|delta):[a-f0-9-]{36}/)?.[0];
  ok(proof);

  const finalMessage = assistants.find((message) => message.finish === "stop");
  ok(finalMessage, "Session did not finish with a final answer");

  const final = (finalMessage.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");

  ok(final.includes(proof), "Final answer did not recover the hidden verification record");
  ok(
    tools.some(
      (part) =>
        part.name === "read" &&
        part.state?.status === "completed" &&
        Object.values(part.state.input ?? {}).includes(path),
    ),
    "No completed native read of the gateway spill",
  );
  ok(
    final.includes("Choose another document ID."),
    "Final answer lost the actionable public error",
  );
  emit("session-passed", {
    session: id,
    toolCalls: tools.length,
    nativeRetrieval: true,
    hiddenVerification: true,
    publicError: true,
  });
}

const records = await jsonl(observer);
const starts = records.filter((record) => record.event === "started");
strictEqual(starts.length, 1, "Agents did not share one gateway process");
const requests = records.filter((record) => record.event === "request");
strictEqual(new Set(requests.map((record) => record.session)).size, 4);
ok(
  requests.some((record) => record.inFlight === 4),
  "No observed four-way gateway overlap",
);
strictEqual(
  records.filter((record) => record.event === "response" && record.isError === true).length,
  4,
);
const events = await jsonl(audit);
for (const event of ["search-start", "search-return", "fetch", "unavailable"]) {
  strictEqual(
    events.filter((record) => record.event === event).length,
    4,
    `Unexpected ${event} count`,
  );
}

ok(events.some((record) => record.event === "search-start" && record.active === 4));
await disconnect();
const closingDeadline = performance.now() + 10_000;
let closed = (await jsonl(observer)).findLast((record) => record.event === "closed");
while (closed === undefined && performance.now() < closingDeadline) {
  await Bun.sleep(25);
  closed = (await jsonl(observer)).findLast((record) => record.event === "closed");
}

ok(closed);
strictEqual(closed.code, 0);
strictEqual(closed.signal, null);
strictEqual(closed.pending, 0);
for (const path of saved) {
  strictEqual(await Bun.file(path).exists(), false);
  strictEqual(
    await stat(dirname(path)).then(
      () => true,
      (cause: unknown) => {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;

        throw cause;
      },
    ),
    false,
  );
}

emit("passed", {
  sessions: 4,
  gatewayProcesses: 1,
  peakInFlight: 4,
  spillsDeleted: saved.size,
  cleanExit: true,
});
passed = true;

function emit(event: string, fields: Record<string, unknown>) {
  console.log(
    JSON.stringify({ event, elapsedMs: Math.round(performance.now() - started), ...fields }),
  );
}

async function jsonl(path: string) {
  return (await Bun.file(path).text())
    .trim()
    .split("\n")
    .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 30_000,
  cwd = directory,
): Promise<unknown> {
  const child = Bun.spawn(
    [
      "opencode",
      "api",
      method,
      path,
      ...(body === undefined ? [] : ["--data", JSON.stringify(body)]),
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );

  let forced = false;

  const watchdog = setTimeout(() => {
    forced = true;
    child.kill("SIGKILL");
  }, timeoutMs);

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    ok(!forced, `OpenCode ${method} ${path} exceeded ${timeoutMs}ms`);
    strictEqual(code, 0, `OpenCode API failed: ${method} ${path}\n${stderr}`);

    return stdout.trim() ? JSON.parse(stdout) : undefined;
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
