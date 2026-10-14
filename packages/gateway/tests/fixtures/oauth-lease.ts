import { acquireLease } from "../../src/auth/lease.ts";

const directory = process.argv[2];
if (directory === undefined) throw new Error("Missing lease fixture directory");

const result = await acquireLease({ id: "test", url: "https://example.com/mcp" }, directory);
if (!result.ok) {
  console.error(result.error.message);
  process.exitCode = 1;
} else {
  await using cleanup = new AsyncDisposableStack();

  cleanup.use(result.value);
  console.log("owned");
  await new Promise<void>(() => {});
}
