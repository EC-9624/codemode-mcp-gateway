import { main } from "../../src/cli/main.ts";

// Model the terminal only in this child process, never in the shared test host.
const columns = Number(process.argv[2]);
if (!Number.isSafeInteger(columns) || columns < 1) throw new Error("Expected a terminal width.");

process.stdout.columns = columns;
process.stdout.isTTY = true;
process.stderr.columns = columns;
process.stderr.isTTY = true;
process.exitCode = await main(process.argv.slice(3));
