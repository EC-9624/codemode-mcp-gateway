import { chmod, copyFile, link, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { force: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  strict: true,
});

if (values.help) {
  console.log(
    "Usage: bun run install:gw [--force]\nBuild and install ~/.local/bin/gw. --force replaces an existing file or symlink. Configuration and services are untouched.",
  );
} else {
  await install();
}

async function install(): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("Local installation requires macOS or Linux.");

  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = join(homedir(), ".local/bin");
  const target = join(directory, "gw");
  if ((await existing(target)) && !values.force)
    throw new Error(`${target} already exists. Run bun run install:gw --force to replace it.`);

  const build = Bun.spawn([process.execPath, "run", "build:standalone"], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  const code = await build.exited;
  if (code !== 0)
    throw new Error(`Standalone build failed (${code}); the installed gw was not changed.`);

  await mkdir(directory, { recursive: true });
  await using cleanup = new AsyncDisposableStack();
  const staging = await mkdtemp(join(directory, ".gw-install-"));
  cleanup.defer(() => rm(staging, { recursive: true, force: true }));
  const binary = join(staging, "gw");
  await copyFile(join(root, "dist/gw"), binary);
  await chmod(binary, 0o755);

  if (values.force) {
    await existing(target);
    // Rename changes the directory entry, not a running executable or symlink target.
    await rename(binary, target);
  } else {
    try {
      // Publish complete bytes without overwriting a file created during the build.
      await link(binary, target);
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "EEXIST") throw cause;

      throw new Error(
        `${target} appeared during installation and was kept. Run bun run install:gw --force to replace it.`,
      );
    }
  }

  console.log(`Installed gw: ${target}`);
  if (!(process.env.PATH ?? "").split(delimiter).includes(directory))
    console.log(`${directory} is not on PATH. Add it yourself; no shell files were edited.`);

  console.log("Next: run gw setup. If needed, invoke gw by the installed absolute path.");
}

async function existing(path: string): Promise<boolean> {
  let info;
  try {
    info = await lstat(path);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;

    throw cause;
  }

  if (!info.isFile() && !info.isSymbolicLink())
    throw new Error(`${path} is not a regular file or symlink. It was not replaced.`);

  return true;
}
