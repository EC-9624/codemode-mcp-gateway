import { execute, ToolResult } from "../src/sandbox";
import { runSandbox } from "../src/worker-execution";

console.log(await execute("return 1 + 2;"));
console.log(await execute('throw new Error("An example failure");'));
console.log(
  await execute("return await tools.add({ a: 1, b: 2 });", {
    add: async (args) => {
      if (
        typeof args !== "object" ||
        args === null ||
        !("a" in args) ||
        !("b" in args) ||
        typeof args.a !== "number" ||
        typeof args.b !== "number"
      ) {
        return ToolResult.failure("add expects numeric a and b.");
      }
      await Bun.sleep(10);
      return ToolResult.success(args.a + args.b);
    },
  }),
);

console.log(await runSandbox("return { answer: 42 };"));
