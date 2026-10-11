import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

describe("sandbox process lifecycle", () => {
  test("allows a process to exit after successful and failed guest executions", async () => {
    const result = await runFixture("worker-process.ts", 10000);

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      results: [
        { ok: true, value: 42 },
        { ok: false, error: { kind: "script", message: "guest failure" } },
        { ok: true, value: 7 },
      ],
    });
  }, 15000);

  test("interrupts busy workers, keeps the host responsive, and lets the process exit", async () => {
    const result = await runFixture("worker-deadline-process.ts", 5000);

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      results: [
        {
          result: {
            ok: false,
            error: { kind: "timeout", message: "Execution exceeded the 100 ms total limit." },
          },
          called: true,
        },
        {
          result: {
            ok: false,
            error: { kind: "timeout", message: "Execution exceeded the 500 ms total limit." },
          },
          called: true,
          responsive: true,
        },
        { ok: false, error: { kind: "timeout", message: "Execution interrupted by the parent." } },
        { ok: true, value: 42 },
      ],
    });
  }, 10000);

  test("interrupts busy startup and guest computation and lets the process exit", async () => {
    const result = await runFixture("worker-cancellation-process.ts", 5000);

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      results: [
        { ok: false, error: { kind: "cancelled", message: "Execution cancelled." } },
        { ok: false, error: { kind: "cancelled", message: "Execution cancelled." } },
        { ok: true, value: 42 },
      ],
    });
  }, 10000);
});

/** Fixtures emit one JSON result per line; the watchdog bounds stuck-worker regressions. */
async function runFixture(file: string, timeoutMs: number) {
  const child = Bun.spawn(
    [process.execPath, fileURLToPath(new URL(`../fixtures/${file}`, import.meta.url))],
    { stdout: "pipe", stderr: "pipe" },
  );

  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    const results = stdout
      .trim()
      .split("\n")
      .map((line) => {
        const value: unknown = JSON.parse(line);

        return value;
      });

    return { exitCode, stderr, results };
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}
