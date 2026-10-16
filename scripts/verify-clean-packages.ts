import { ok, strictEqual } from "node:assert";
import { cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
strictEqual(process.argv.length, 2, "Usage: bun run verify:packages:clean");
await using cleanup = new AsyncDisposableStack();
const directory = await mkdtemp(join(tmpdir(), "cmg-clean-packages-"));
cleanup.defer(() => rm(directory, { recursive: true, force: true }));
const source = join(directory, "source");
await mkdir(source);

// Copy the current source, including uncommitted work, not an old HEAD archive.
// Git supplies the inventory only: this never creates a worktree or copies ignored
// installs/builds, and the shared checkout is never cleaned to simulate a fresh one.
const inventory = await run(
  ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  root,
);

for (const path of new Set(inventory.split("\0").filter(Boolean))) {
  ok(!path.split("/").some((part) => ["..", "node_modules", "dist", ".git"].includes(part)));
  const original = join(root, path);
  const exists = await Bun.file(original).exists();
  if (!exists) continue;

  await mkdir(dirname(join(source, path)), { recursive: true });
  await cp(original, join(source, path), { dereference: false });
}

for (const path of [
  "node_modules",
  "packages/codemode/dist",
  "packages/mcp/dist",
  "packages/gateway/dist",
]) {
  const exists = await stat(join(source, path)).then(
    () => true,
    (cause: unknown) => {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;

      throw cause;
    },
  );

  strictEqual(exists, false, `Clean source inherited ${path}`);
}

await run([process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"], source);
// Explicit build preserves user ignore-scripts policy instead of weakening it to
// make implicit lifecycle hooks run. The normal verifier packs with scripts off.
await run([process.execPath, "run", "build"], source);
await run([process.execPath, "run", "scripts/verify-packages.ts"], source);
console.log(
  "Clean source verified: frozen install, explicit build, tarball inventory, and installed consumers.",
);

async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  let forced = false;

  const watchdog = setTimeout(() => {
    forced = true;
    child.kill("SIGKILL");
  }, 120_000);

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    ok(!forced, `${command.join(" ")} exceeded 120 seconds`);
    strictEqual(code, 0, `${command.join(" ")} failed.\n${stdout}${stderr}`);

    return stdout;
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
