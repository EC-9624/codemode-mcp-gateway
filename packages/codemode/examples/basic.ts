import { CodeExecutor, ToolResult } from "@codemode-mcp-gateway/codemode";

const executor = new CodeExecutor({
  tools: { answer: () => ToolResult.success(42) },
  timeoutMs: 1_000,
  totalTimeoutMs: 5_000,
});

console.log(await executor.execute("return await tools.answer();"));
