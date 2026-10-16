import { CodeExecutor, ToolResult } from "@codemode-mcp-gateway/codemode";

for (const code of ["return 42;", 'throw new Error("guest failure");']) {
  console.log(JSON.stringify((await new CodeExecutor().execute(code)).result));
}

console.log(
  JSON.stringify(
    (
      await new CodeExecutor({
        tools: {
          read: () => ToolResult.success(7),
        },
      }).execute("return await tools.read();")
    ).result,
  ),
);
