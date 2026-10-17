import { expect, test } from "bun:test";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("local installation builds from its checkout and installs only an executable", async () => {
  await using files = await fixture();
  const config = join(files.home, ".config/codemode-mcp-gateway/config.json");
  const token = join(files.home, ".local/state/codemode-mcp-gateway/token");
  const client = join(files.home, ".claude.json");
  await Bun.write(config, "user-owned configuration\n");
  await Bun.write(token, "user-owned credential\n");
  await Bun.write(client, "user-owned client settings\n");
  await Bun.write(join(files.root, "dist/gw"), "stale build\n");

  const result = await files.run();

  expect(result.code).toBe(0);
  expect(await Bun.file(files.target).text()).toBe("fresh build\n");
  expect((await lstat(files.target)).mode & 0o777).toBe(0o755);
  expect(await Bun.file(join(files.root, "build-cwd")).text()).toBe(files.root);
  expect(await readdir(files.bin)).toEqual(["gw"]);
  expect(result.stdout).toContain(`Installed gw: ${files.target}`);
  expect(result.stdout).toContain("Next: run gw setup");
  expect(result.stdout).toContain("is not on PATH");
  expect(await Bun.file(config).text()).toBe("user-owned configuration\n");
  expect(await Bun.file(token).text()).toBe("user-owned credential\n");
  expect(await Bun.file(client).text()).toBe("user-owned client settings\n");
  expect(await Bun.file(join(files.home, ".zshrc")).exists()).toBe(false);
});

test("local installation refuses an existing executable before building", async () => {
  await using files = await fixture();
  await Bun.write(files.target, "existing executable\n");

  const result = await files.run();

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("install:gw --force");
  expect(await Bun.file(files.target).text()).toBe("existing executable\n");
  expect(await Bun.file(join(files.root, "build-cwd")).exists()).toBe(false);
});

test("forced installation replaces the directory entry without changing the old executable inode", async () => {
  await using files = await fixture();
  await Bun.write(files.target, "previous executable\n");
  const previous = join(files.directory, "previous-gw");
  await link(files.target, previous);
  const original = await lstat(files.target);

  const result = await files.run(["--force"]);

  expect(result.code).toBe(0);
  expect(await Bun.file(files.target).text()).toBe("fresh build\n");
  expect((await lstat(files.target)).ino).not.toBe(original.ino);
  expect(await Bun.file(previous).text()).toBe("previous executable\n");
  expect(await readdir(files.bin)).toEqual(["gw"]);
});

test("forced installation replaces a symlink without modifying its target", async () => {
  await using files = await fixture();
  const previous = join(files.directory, "other-executable");
  await Bun.write(previous, "unrelated executable\n");
  await mkdir(files.bin, { recursive: true });
  await symlink(previous, files.target);

  const result = await files.run(["--force"]);

  expect(result.code).toBe(0);
  expect((await lstat(files.target)).isFile()).toBe(true);
  expect(await Bun.file(files.target).text()).toBe("fresh build\n");
  expect(await Bun.file(previous).text()).toBe("unrelated executable\n");
});

test("forced installation preserves the previous executable when the build fails", async () => {
  await using files = await fixture();
  await Bun.write(files.target, "previous executable\n");
  await Bun.write(join(files.root, "dist/gw"), "stale build\n");
  await Bun.write(files.build, "process.exit(9);\n");

  const result = await files.run(["--force"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Standalone build failed (9)");
  expect(result.stdout).not.toContain("Installed gw");
  expect(await Bun.file(files.target).text()).toBe("previous executable\n");
  expect(await readdir(files.bin)).toEqual(["gw"]);
});

test("local installation preserves a file that appears during the build", async () => {
  await using files = await fixture();
  await Bun.write(
    files.build,
    `await Bun.write(${JSON.stringify(files.target)}, "concurrent executable\\n");
await Bun.write("dist/gw", "fresh build\\n");`,
  );

  const result = await files.run();

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("appeared during installation and was kept");
  expect(await Bun.file(files.target).text()).toBe("concurrent executable\n");
  expect(await readdir(files.bin)).toEqual(["gw"]);
});

test("forced installation refuses a directory at the destination", async () => {
  await using files = await fixture();
  await mkdir(files.target, { recursive: true });
  await Bun.write(join(files.target, "user-file"), "user-owned file\n");

  const result = await files.run(["--force"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("not a regular file or symlink");
  expect(await Bun.file(join(files.target, "user-file")).text()).toBe("user-owned file\n");
  expect(await Bun.file(join(files.root, "build-cwd")).exists()).toBe(false);
});

test("installation help does not build or create the destination", async () => {
  await using files = await fixture();

  const result = await files.run(["--help"]);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Usage: bun run install:gw [--force]");
  expect(await Bun.file(files.target).exists()).toBe(false);
  expect(await Bun.file(join(files.root, "build-cwd")).exists()).toBe(false);
});

test("local installation does not warn when its destination is already on PATH", async () => {
  await using files = await fixture();

  const result = await files.run([], files.bin);

  expect(result.code).toBe(0);
  expect(result.stdout).not.toContain("is not on PATH");
  expect(await Bun.file(files.target).text()).toBe("fresh build\n");
});

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "gw-install-")));
  const root = join(directory, "checkout with spaces");
  const home = join(directory, "home with spaces");
  const bin = join(home, ".local/bin");
  const script = join(root, "scripts/install-gw.ts");
  const build = join(root, "scripts/build-fixture.ts");
  await mkdir(join(root, "scripts"), { recursive: true });
  await copyFile(fileURLToPath(new URL("../../../scripts/install-gw.ts", import.meta.url)), script);
  // This small process fixture owns the build command boundary. The clean-source
  // verifier separately exercises install:gw with the real complete build.
  await Bun.write(
    join(root, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: {
        "build:standalone": `${JSON.stringify(process.execPath)} scripts/build-fixture.ts`,
      },
    }),
  );
  await Bun.write(
    build,
    'await Bun.write("build-cwd", process.cwd());\nawait Bun.write("dist/gw", "fresh build\\n");\n',
  );

  return {
    directory,
    root,
    home,
    bin,
    build,
    target: join(bin, "gw"),
    async run(args: string[] = [], path = "") {
      const child = Bun.spawn([process.execPath, script, ...args], {
        cwd: directory,
        env: { ...process.env, HOME: home, PATH: path },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });

      const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);

        return { code, stdout, stderr };
      } finally {
        clearTimeout(deadline);
        if (child.exitCode === null) child.kill("SIGKILL");

        await child.exited;
      }
    },
    [Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true }),
  };
}
