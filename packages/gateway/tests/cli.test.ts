import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

describe("cmg executable", () => {
  test.each([
    { name: "missing configuration", args: [] },
    { name: "extra arguments", args: ["unused.json", "extra"] },
    { name: "login without configuration", args: ["login"] },
    { name: "logout without configuration", args: ["logout"] },
    { name: "unknown command", args: ["unknown", "unused.json"] },
  ])("rejects $name with usage on stderr", async ({ args }) => {
    const result = await runProcess([cli, ...args]);

    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: "Usage: cmg <configuration.json>\n",
    });
  });

  test("reports an unreadable configuration without writing protocol output", async () => {
    const path = fileURLToPath(new URL("./fixtures/missing-configuration.json", import.meta.url));

    const result = await runProcess([cli, path]);

    expect(result).toEqual({
      code: 1,
      stdout: "",
      stderr: `Could not read configuration JSON at ${path}.\n`,
    });
  });

  test("the programmatic entry leaves shutdown listeners unchanged and lets the process exit", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/import-gateway.ts", import.meta.url));

    const result = await runProcess([fixture]);

    expect(result).toEqual({ code: 0, stdout: "gateway-imported\n", stderr: "" });
  });
});

async function runProcess(args: string[]) {
  const child = Bun.spawn([process.execPath, "--conditions=development", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(() => child.kill(), 4_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}
