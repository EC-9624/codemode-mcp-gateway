import { execute, ToolResult } from "../../src/sandbox";

for (const code of ["return 42;", 'throw new Error("guest failure");']) {
  console.log(JSON.stringify((await execute(code)).result));
}

console.log(
  JSON.stringify(
    (
      await execute("return await tools.read();", {
        read: () => ToolResult.success(7),
      })
    ).result,
  ),
);
