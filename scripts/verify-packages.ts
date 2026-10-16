import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { deepEqual, ok } from "node:assert/strict";
import { z } from "zod";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({ options: { archives: { type: "string" } }, strict: true });
await using cleanup = new AsyncDisposableStack();
const directory = await mkdtemp(join(tmpdir(), "cmg-packages-"));
cleanup.defer(() => rm(directory, { recursive: true, force: true }));

for (const [workspace, file, required] of [
  ["packages/codemode", "codemode.tgz", "package/dist/runtime/worker.js"],
  ["packages/mcp", "mcp.tgz", "package/dist/index.d.ts"],
  ["packages/gateway", "gateway.tgz", "package/dist/cli.js"],
] as const) {
  const archive = join(directory, file);
  if (values.archives === undefined) {
    await run(
      [process.execPath, "pm", "pack", "--ignore-scripts", "--filename", archive],
      join(root, workspace),
    );
  } else {
    await Bun.write(archive, Bun.file(join(values.archives, file)));
  }

  const entries = (await run(["tar", "-tf", archive], directory)).trim().split("\n");
  ok(entries.includes(required), `Missing built asset ${required}`);
  ok(entries.includes("package/README.md"), "Package documentation must be included");
  if (workspace === "packages/codemode")
    ok(entries.includes("package/THIRD_PARTY_NOTICES.md"), "Bundled SDK license must be included");

  const sources = await readdir(join(root, workspace, "src"), { recursive: true });

  const expected = sources
    .filter((source) => source.endsWith(".ts"))
    .flatMap((source) => [
      "package/dist/" + source.replace(/\.ts$/, ".js"),
      "package/dist/" + source.replace(/\.ts$/, ".d.ts"),
    ])
    .sort();

  const built = entries
    .filter((entry) => entry.startsWith("package/dist/") && !entry.endsWith("/"))
    .sort();

  deepEqual(built, expected, `Built assets for ${workspace} must match current source files`);

  ok(
    entries.every((entry) => !/^package\/(src|tests|node_modules)\//.test(entry)),
    "Development files must not ship",
  );

  const manifest: unknown = JSON.parse(
    await run(["tar", "-xOf", archive, "package/package.json"], directory),
  );

  const parsed = z.object({ dependencies: z.record(z.string(), z.string()) }).parse(manifest);
  ok(
    Object.values(parsed.dependencies).every((version) => !version.startsWith("workspace:")),
    "Packed dependencies must be installable outside the workspace",
  );
}

const compiler = {
  compilerOptions: {
    target: "ESNext",
    module: "Preserve",
    moduleResolution: "Bundler",
    lib: ["ESNext"],
    types: ["bun"],
    strict: true,
    noEmit: true,
    skipLibCheck: false,
  },
  include: ["*.ts"],
};

const standalone = join(directory, "standalone");
await Bun.write(
  join(standalone, "package.json"),
  JSON.stringify({
    name: "codemode-standalone-consumer",
    private: true,
    type: "module",
    scripts: { typecheck: "tsc --noEmit" },
    dependencies: { "@codemode-mcp-gateway/codemode": `file:${join(directory, "codemode.tgz")}` },
    devDependencies: { typescript: "7.0.2", "@types/bun": "1.4.2" },
  }),
);
await Bun.write(join(standalone, "tsconfig.json"), JSON.stringify(compiler));
await Bun.write(
  join(standalone, "consumer.ts"),
  Bun.file(join(root, "packages/codemode/tests/fixtures/packaged-codemode.ts")),
);
await run([process.execPath, "install", "--ignore-scripts"], standalone);
await run([process.execPath, "run", "typecheck"], standalone);
await run([process.execPath, "consumer.ts"], standalone);

const consumer = join(directory, "consumer");
await Bun.write(
  join(consumer, "package.json"),
  JSON.stringify({
    name: "cmg-package-consumer",
    private: true,
    type: "module",
    scripts: { typecheck: "tsc --noEmit" },
    dependencies: {
      "@codemode-mcp-gateway/codemode": `file:${join(directory, "codemode.tgz")}`,
      "@codemode-mcp-gateway/mcp": `file:${join(directory, "mcp.tgz")}`,
      "codemode-mcp-gateway": `file:${join(directory, "gateway.tgz")}`,
      "@modelcontextprotocol/client": "2.3.1",
      "@modelcontextprotocol/server": "2.3.1",
      zod: "4.3.6",
    },
    devDependencies: { typescript: "7.0.2", "@types/bun": "1.4.2" },
    // Local tarballs stand in for registry versions that have deliberately not been published.
    overrides: {
      "@codemode-mcp-gateway/codemode": `file:${join(directory, "codemode.tgz")}`,
      "@codemode-mcp-gateway/mcp": `file:${join(directory, "mcp.tgz")}`,
    },
  }),
);
await Bun.write(
  join(consumer, "tsconfig.json"),
  JSON.stringify({
    ...compiler,
    compilerOptions: { ...compiler.compilerOptions, allowImportingTsExtensions: true },
  }),
);

for (const [source, target] of [
  ["packages/gateway/tests/fixtures/packaged-consumer.ts", "consumer.ts"],
  ["packages/gateway/tests/fixtures/import-gateway.ts", "import-gateway.ts"],
  ["examples/mcp-server.ts", "upstream/mcp-server.ts"],
  ["examples/mcp-tools.ts", "upstream/mcp-tools.ts"],
] as const) {
  await Bun.write(join(consumer, target), Bun.file(join(root, source)));
}

await Bun.write(
  join(consumer, "config/cmg.json"),
  JSON.stringify({
    mcp: {
      servers: {
        math: { type: "local", command: [process.execPath, "mcp-server.ts"], cwd: "../upstream" },
      },
    },
    sandbox: { timeoutMs: 5_000, totalTimeoutMs: 10_000 },
  }),
);
await run([process.execPath, "install", "--ignore-scripts"], consumer);
await run([process.execPath, "run", "typecheck"], consumer);
await run([process.execPath, "import-gateway.ts"], consumer);
await run(
  [
    process.execPath,
    "consumer.ts",
    join(consumer, "node_modules/.bin/gw"),
    join(consumer, "config/cmg.json"),
  ],
  consumer,
);
console.log(
  "Packed packages verified: declarations, worker execution/cancellation, MCP adapter, and CLI.",
);

/** A timeout bounds regressions that leave workers or child processes running. */
async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill(), 30_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    if (code !== 0) throw new Error(`${command.join(" ")} failed (${code}).\n${stdout}${stderr}`);

    return stdout;
  } finally {
    clearTimeout(timeout);
    child.kill();
  }
}
