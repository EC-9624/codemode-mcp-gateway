import { CodemodeSandbox, ToolResult } from "../../src/codemode";

for (const code of ["return 42;", 'throw new Error("guest failure");']) {
  console.log(JSON.stringify((await new CodemodeSandbox().execute(code)).result));
}

console.log(
  JSON.stringify(
    (
      await new CodemodeSandbox({
        tools: {
          read: () => ToolResult.success(7),
        },
      }).execute("return await tools.read();")
    ).result,
  ),
);
