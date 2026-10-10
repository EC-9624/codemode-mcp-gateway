import { createDiscoveryTools, execute, ToolCatalog, ToolResult } from "../src/sandbox";

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

console.log(await execute("while (true) {}", {}, { timeoutMs: 100 }));

const catalog = ToolCatalog.create({
  answer: {
    description: "Return the answer to the example question",
    execute: () => ToolResult.success(42),
  },
});
const discovery = createDiscoveryTools(catalog);
console.log(
  await execute(
    `
  const matches = await tools.searchTools({ query: "answer" });
  return await tools[matches[0].name]();
`,
    { ...catalog.tools, searchTools: discovery.searchTools, describeTool: discovery.describeTool },
  ),
);
