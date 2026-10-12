import { z } from "zod";
import {
  CodemodeSandbox,
  createDiscoveryTools,
  defineTool,
  execute,
  ToolCatalog,
  ToolResult,
} from "../src/codemode";

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
console.log(await execute("while (true) {}", {}, { timeoutMs: 1000, totalTimeoutMs: 100 }));

console.log(await execute("return 42;", {}, { maxSourceBytes: 5 }));
console.log(await execute('return "too much";', {}, { maxOutputBytes: 5 }));
console.log(
  await execute(
    "return new ArrayBuffer(1024).byteLength;",
    {},
    { memoryLimitBytes: 8 * 1024 * 1024 },
  ),
);

console.log(
  await execute(
    "await tools.read(); return await tools.read();",
    {
      read: () => ToolResult.success(42),
    },
    { maxToolCalls: 1 },
  ),
);

const controller = new AbortController();
const started = Promise.withResolvers<void>();

const cancelled = execute(
  "await tools.createInvoice(); return await tools.wait();",
  {
    createInvoice: () => ToolResult.success({ id: "invoice-1" }),
    wait: async (_args, { signal }) => {
      const stopped = Promise.withResolvers<void>();
      const onAbort = () => stopped.resolve();
      using cleanup = new DisposableStack();
      cleanup.defer(() => signal.removeEventListener("abort", onAbort));
      signal.addEventListener("abort", onAbort, { once: true });
      started.resolve();
      await stopped.promise;

      return ToolResult.failure("Stopped");
    },
  },
  { signal: controller.signal },
);

await started.promise;
controller.abort();
console.log(await cancelled);

const catalog = ToolCatalog.create({
  answer: {
    description: "Return the answer to the example question",
    execute: () => ToolResult.success(42),
  },
  echo: defineTool({
    description: "Return a non-empty string",
    inputSchema: z
      .string()
      .min(1)
      .transform((value) => value.toUpperCase()),
    execute: (args) => ToolResult.success(args),
  }),
});

const discovery = createDiscoveryTools(catalog);

const sandbox = new CodemodeSandbox({
  tools: {
    ...catalog.tools,
    searchTools: discovery.searchTools,
    describeTool: discovery.describeTool,
  },
});

console.log(
  await sandbox.execute(
    `
  const matches = await tools.searchTools({ query: "answer" });
  return await tools[matches[0].name]();
`,
  ),
);

console.log(
  await sandbox.execute(
    `
  try { await tools.echo(42); }
  catch (error) { return { validation: error.message, recovered: await tools.echo("valid") }; }
`,
  ),
);
