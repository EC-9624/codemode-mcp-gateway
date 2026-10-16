import { ok, strictEqual } from "node:assert";
import { cp, lstat, mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

strictEqual(process.argv.length, 2, "Usage: bun run install:local");
strictEqual(Bun.version, "1.4.3", "Local installation requires Bun 1.4.3.");
const root = fileURLToPath(new URL("../", import.meta.url));
const home = join(homedir(), ".local/share/codemode-mcp-gateway");
const revision = (await run(["git", "rev-parse", "HEAD"], root)).trim();
const dirty = (await run(["git", "status", "--porcelain"], root)).trim() !== "";
const id = `${revision.slice(0, 7)}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const installation = join(home, "installs", id);
const current = join(home, "current");

const previous = await lstat(current).catch((cause: unknown) => {
  if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;

  throw cause;
});

ok(
  previous === undefined || previous.isSymbolicLink(),
  "Refusing to replace a non-symlink current installation.",
);

await using cleanup = new AsyncDisposableStack();
const scratch = await mkdtemp(join(tmpdir(), "gw-install-"));
cleanup.defer(() => rm(scratch, { recursive: true, force: true }));
const source = join(scratch, "source");
await mkdir(source);

// Build a current-source snapshot, never a workspace link. Git supplies file names
// without copying ignored installs/builds or creating another Git worktree.
const inventory = await run(
  ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  root,
);

for (const path of new Set(inventory.split("\0").filter(Boolean))) {
  ok(!path.split("/").some((part) => ["..", "node_modules", "dist", ".git"].includes(part)));
  const original = join(root, path);
  if (!(await Bun.file(original).exists())) continue;

  await mkdir(dirname(join(source, path)), { recursive: true });
  await cp(original, join(source, path), { dereference: false });
}

await mkdir(dirname(installation), { recursive: true, mode: 0o700 });
await mkdir(installation, { mode: 0o700 });
let activated = false;
cleanup.defer(async () => {
  if (!activated) await rm(installation, { recursive: true, force: true });
});
console.log("Building a disposable source copy with lifecycle scripts disabled.");
await run([process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"], source);
await run([process.execPath, "run", "build"], source);
for (const name of ["codemode", "mcp", "gateway"]) {
  await run(
    [
      process.execPath,
      "pm",
      "pack",
      "--ignore-scripts",
      "--filename",
      join(installation, `${name}.tgz`),
    ],
    join(source, "packages", name),
  );
}

await Bun.write(
  join(installation, "package.json"),
  JSON.stringify(
    {
      name: "codemode-mcp-gateway-local",
      private: true,
      type: "module",
      dependencies: { "codemode-mcp-gateway": "file:./gateway.tgz" },
      overrides: {
        "@codemode-mcp-gateway/codemode": "file:./codemode.tgz",
        "@codemode-mcp-gateway/mcp": "file:./mcp.tgz",
      },
    },
    null,
    2,
  ) + "\n",
);
await run([process.execPath, "install", "--ignore-scripts"], installation);
const cli = join(installation, "node_modules/codemode-mcp-gateway/dist/cli.js");
strictEqual((await run([process.execPath, cli, "--version"], installation)).trim(), "gw 0.0.0");
console.log("Verifying candidate tarballs through isolated installed consumers.");
await run(
  [process.execPath, join(source, "scripts/verify-packages.ts"), "--archives", installation],
  source,
);
await Bun.write(
  join(installation, "installation.json"),
  JSON.stringify(
    { revision, dirty, installedAt: new Date().toISOString(), bun: Bun.version },
    null,
    2,
  ) + "\n",
);

// Activate only a verified candidate. Old installs remain intact for running
// client-owned processes and explicit rollback; no daemon or client is restarted.
const pending = join(home, `.current-${crypto.randomUUID()}`);
cleanup.defer(() => rm(pending, { force: true }));
await symlink(relative(home, installation), pending);
await rename(pending, current);
activated = true;
console.log(
  `Installed gw: ${installation}\nActive installation: ${current}\nRun gw service install for first setup, or gw service restart to adopt this build.`,
);

async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  let forced = false;

  const watchdog = setTimeout(() => {
    forced = true;
    child.kill("SIGKILL");
  }, 180_000);

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    ok(!forced, `${command.join(" ")} exceeded 180 seconds`);
    strictEqual(code, 0, `${command.join(" ")} failed.\n${stdout}${stderr}`);

    return stdout;
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
