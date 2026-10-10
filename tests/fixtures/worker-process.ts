import { executeInWorker } from "../../src/worker-execution";

for (const code of ["return 42;", 'throw new Error("guest failure");']) {
  console.log(JSON.stringify(await executeInWorker(code)));
}
