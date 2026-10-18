import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, type CallToolResult } from "@modelcontextprotocol/client";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { waitForServer } from "../packages/gateway/examples/readiness.ts";

const workflows = ["alpha", "bravo", "charlie", "delta"];
const saved = new Set<string>();
const started = performance.now();

function evidence(event: string, details: Record<string, unknown> = {}) {
  console.log(
    JSON.stringify({ event, elapsedMs: Math.round(performance.now() - started), ...details }),
  );
}

async function validate() {
  strictEqual(
    process.argv.length,
    2,
    "Usage: bun --conditions=development run scripts/agent-validation.ts",
  );
  evidence("environment", {
    bun: Bun.version,
    requiredBun: "1.4.3",
    platform: process.platform,
    arch: process.arch,
    workflows: 4,
    topology: "scripted workflows; one MCP client; CLI stdio; local fixture",
  });
  strictEqual(Bun.version, "1.4.3", "Run this diagnostic with Bun 1.4.3.");

  await using cleanup = new AsyncDisposableStack();
  const directory = await mkdtemp(join(tmpdir(), "cmg-agent-validation-"));
  cleanup.defer(() => rm(directory, { recursive: true, force: true }));
  const configuration = join(directory, "config.json");
  await Bun.write(
    configuration,
    JSON.stringify({
      mcp: {
        servers: {
          documents: {
            type: "local",
            command: [
              process.execPath,
              fileURLToPath(new URL("./fixtures/agent-validation-upstream.ts", import.meta.url)),
            ],
          },
        },
      },
      sandbox: { maxConcurrentExecutions: 4, totalTimeoutMs: 20_000 },
    }),
  );

  const child = spawn(
    process.execPath,
    [
      "--conditions=development",
      fileURLToPath(new URL("../packages/gateway/src/cli.ts", import.meta.url)),
      "serve",
      "--transport",
      "stdio",
      "--config",
      configuration,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  const closed = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  child.once("close", (code, signal) => closed.resolve({ code, signal }));
  let spawnFailed = false;
  child.once("error", () => {
    spawnFailed = true;
  });
  let stderr = "";
  child.stderr.on("data", (chunk: unknown) => {
    if (Buffer.isBuffer(chunk)) stderr += chunk.toString("utf8");
  });
  let forced = false;

  function forceStop() {
    forced = true;
    // The upstream inherits stderr. Kill it too, or child `close` could wait forever
    // for that inherited pipe after the gateway itself has already been killed.
    const pid = stderr.match(/agent-validation-pid:(\d+)/)?.[1];
    if (pid !== undefined) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch (cause) {
        if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ESRCH") throw cause;
      }
    }

    child.kill("SIGKILL");
  }

  const watchdog = setTimeout(forceStop, 60_000);

  cleanup.defer(() => clearTimeout(watchdog));
  const client = new Client({ name: "cmg-agent-validation", version: "1" });
  const transport = new StdioServerTransport(child.stdout, child.stdin);

  // Do not use a client subprocess transport: its escalation could mask a broken EOF shutdown.
  cleanup.defer(async () => {
    const shutdownWatchdog = setTimeout(forceStop, 10_000);

    child.stdin.end();
    const exit = await closed.promise;
    clearTimeout(shutdownWatchdog);
    await client.close();
    const pid = stderr.match(/agent-validation-pid:(\d+)/)?.[1];
    let upstreamAlive = false;
    if (pid !== undefined) {
      try {
        process.kill(Number(pid), 0);
        upstreamAlive = true;
        // Failure-only cleanup; never report this as a natural shutdown.
        process.kill(Number(pid), "SIGKILL");
      } catch (cause) {
        if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ESRCH") throw cause;
      }
    }

    const deleted = await Promise.all([...saved].map(missing));

    const directoriesDeleted = await Promise.all(
      [...new Set([...saved].map((path) => dirname(path)))].map(missing),
    );

    const passed =
      !forced &&
      !spawnFailed &&
      exit.code === 0 &&
      exit.signal === null &&
      pid !== undefined &&
      stderr.includes("agent-validation-exit") &&
      !upstreamAlive &&
      deleted.every(Boolean) &&
      directoriesDeleted.every(Boolean);

    evidence("shutdown", {
      status: passed ? "passed" : "failed",
      ...exit,
      forced,
      upstreamExitObserved: stderr.includes("agent-validation-exit"),
      upstreamAlive,
      savedFiles: saved.size,
      filesDeleted: deleted.every(Boolean),
      directoriesDeleted: directoriesDeleted.every(Boolean),
    });
    ok(passed, "EOF shutdown or saved-output cleanup failed.");
  });

  await client.connect(transport, { timeout: 10_000 });
  await waitForServer(client, "documents", 10_000);
  const listing = await client.listTools();
  deepStrictEqual(
    listing.tools.map((tool) => tool.name),
    ["execute"],
  );
  evidence("startup", { status: "passed", executeOnly: true });

  async function execute(workflow: string, step: string, code: string, failure = false) {
    const start = performance.now();

    const response = await client.callTool(
      { name: "execute", arguments: { code } },
      { timeout: 25_000 },
    );

    strictEqual(
      response.isError,
      failure ? true : undefined,
      `${workflow}/${step}: unexpected execution outcome`,
    );
    const text = displayText(response);
    evidence("request", {
      workflow,
      step,
      status: "passed",
      expectedError: failure,
      elapsedRequestMs: Math.round(performance.now() - start),
      responseBytes: Buffer.byteLength(text),
    });

    return text;
  }

  const results = await Promise.allSettled(
    workflows.map(async (workflow) => {
      const discovery = await execute(
        workflow,
        "discover",
        'return (await tools.searchTools({ query: "documents", server: "documents" })).tools.map(tool => tool.name).sort();',
      );

      deepStrictEqual(JSON.parse(discovery), [
        "documents.audit",
        "documents.fetch",
        "documents.search",
        "documents.unavailable",
      ]);

      const schema = await execute(
        workflow,
        "describe",
        'const tool = await tools.describeTool({ name: "documents.fetch" }); return { name: tool.name, type: tool.inputSchema.type, required: tool.inputSchema.required };',
      );

      deepStrictEqual(JSON.parse(schema), {
        name: "documents.fetch",
        type: "object",
        required: ["id"],
      });

      const search = await execute(
        workflow,
        "search-gate",
        `const result = await tools["documents.search"]({ workflow: ${JSON.stringify(workflow)} }); return JSON.parse(result.content[0].text);`,
      );

      deepStrictEqual(JSON.parse(search), {
        id: workflow,
        marker: `document:${workflow}`,
        overlappingSearches: 4,
      });

      const preview = await execute(
        workflow,
        "fetch-large",
        `const result = await tools["documents.fetch"]({ id: ${JSON.stringify(workflow)} }); return JSON.parse(result.content[0].text).text;`,
      );

      const path = preview.match(/\[Full output: ([^\n]+)\]/)?.[1];
      ok(path, `${workflow}: missing full-output path`);
      ok(!saved.has(path), "Concurrent results must have distinct files.");
      saved.add(path);
      ok(Buffer.byteLength(preview) <= 40_000, "Preview exceeded the inline byte budget.");
      ok(!preview.includes("�"), "Preview split a Unicode character.");
      ok(preview.startsWith(`document:${workflow}|`));
      ok(preview.includes(`|end:${workflow}`));
      ok(preview.includes("… output truncated …"));
      ok(preview.includes("native file or shell tools"));
      // Native host filesystem retrieval, not another guest execution or replay of the fetch.
      const full = await Bun.file(path).text();
      strictEqual(full, `document:${workflow}|${"日😀".repeat(45_000)}|end:${workflow}`);
      strictEqual(full.includes("\n"), false);
      evidence("retrieval", {
        workflow,
        status: "passed",
        exact: true,
        unicode: true,
        singleLine: true,
        bytes: Buffer.byteLength(full),
        previewBytes: Buffer.byteLength(preview),
      });

      const publicError = await execute(
        workflow,
        "public-error",
        `const result = await tools["documents.unavailable"]({ workflow: ${JSON.stringify(workflow)} }); if (result.isError) throw new Error(result.content[0].text); throw new Error("Expected upstream tool error.");`,
        true,
      );

      strictEqual(publicError, `Document ${workflow} is unavailable. Choose another document ID.`);
      evidence("public-error", { workflow, status: "passed", message: publicError });
      evidence("workflow", { workflow, status: "passed" });
    }),
  );

  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }

  const audit = await execute(
    "all",
    "audit",
    'const result = await tools["documents.audit"]({}); return JSON.parse(result.content[0].text);',
  );

  const expectedAudit = {
    counts: { search: 4, fetch: 4, unavailable: 4 },
    arrivals: workflows,
    peak: 4,
    active: 0,
  };

  deepStrictEqual(JSON.parse(audit), expectedAudit);
  strictEqual(saved.size, 4);
  evidence("overlap-and-replay", { status: "passed", ...expectedAudit });
}

function displayText(response: CallToolResult) {
  strictEqual(
    response.structuredContent,
    undefined,
    "Expected current text-only execute response.",
  );
  strictEqual(response.content.length, 1);
  const block = response.content[0];
  ok(block?.type === "text", "Expected one text block.");

  return block.text;
}

async function missing(path: string) {
  try {
    await stat(path);

    return false;
  } catch (cause) {
    if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") throw cause;

    return true;
  }
}

try {
  await validate();
  evidence("complete", { status: "passed" });
} catch (cause) {
  // Assertions can include document bodies. Keep failure evidence compact and body-free.
  evidence("complete", {
    status: "failed",
    kind: cause instanceof Error ? cause.name : "unknown",
    message: "Validation failed; inspect the last completed phase. No operation is retried.",
  });
  process.exitCode = 1;
}
