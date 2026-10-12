# MCM

A code-mode sandbox built in small, explainable slices toward production readiness.
Submitted JavaScript runs in QuickJS inside a fresh Bun worker and can call only
the host tools supplied by the application. Pi and Executor are design references,
not runtime dependencies.

## Run

Requires Bun **1.4.2**, pinned in `.bun-version`. Bun is the supported host runtime.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run example
bun run example:mcp
bun run check
```

## Usage

Import execution from `src/codemode` and MCP integration from `src/mcp`.
Submit an async function body:

```ts
import { CodemodeSandbox, ToolResult } from "./src/codemode";

const sandbox = new CodemodeSandbox({
  tools: { answer: () => ToolResult.success(42) },
  timeoutMs: 1_000,
});

const report = await sandbox.execute("return await tools.answer();");

console.log(report.result); // { ok: true, value: 42 }
console.log(report.calls);
// [{ callId: 1, name: "answer", status: "completed", result: { ok: true, json: "42" } }]
```

`CodemodeSandbox` snapshots tool bindings and defaults at construction. Each
`execute(code, options?)` gets a fresh worker, VM, call budget, and report; executions
can overlap. Per-call options override defaults for that run, and cancellation is
per call. Worker cleanup completes before each execution settles.

For one-shot use, `execute(code, tools?, options?)` is also exported by `src/codemode`.

Tool callbacks receive unknown arguments and an execution-scoped `AbortSignal`.
Use `defineTool` with a Standard Schema validator for typed handlers, or validate
inside the callback. `ToolResult.failure(message)` produces a catchable guest
rejection; unexpected callback exceptions produce a generic, private-error-safe rejection.

### Public API

| Export                                                | Purpose                                                                |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| `CodemodeSandbox`                                     | Reusable tool bindings and execution defaults                          |
| `execute(code, tools?, options?)`                     | Run code and return its result plus observed tool calls                |
| `ToolResult.success(value)` / `.failure(message)`     | Explicit host-tool outcomes                                            |
| `defineTool(definition)`                              | Bind a typed Standard Schema validator to a handler                    |
| `validateTool(schema, handler, name?)`                | Adapt a Standard Schema validator and typed handler to a host callback |
| `ToolCatalog.create(definitions)`                     | Snapshot tools and their discovery metadata                            |
| `createDiscoveryTools(catalog)`                       | Expose catalog search and description as host tools                    |
| `createMcpCatalog(client, options?)` (from `src/mcp`) | Adapt a connected, application-owned MCP client                        |
| `SandboxExecutionError`                               | Host infrastructure failure carrying a cause and call snapshot         |

Script errors, timeouts, cancellation, and admission/output limits resolve in
`report.result`. Infrastructure failures reject with `SandboxExecutionError`;
invalid execution options reject with `RangeError`.

MCP composition uses the same tool contract:

```ts
import { CodemodeSandbox } from "./src/codemode";
import { createMcpCatalog } from "./src/mcp";

// The application owns the connected MCP SDK client and closes it when done.
const catalog = await createMcpCatalog(client);
const sandbox = new CodemodeSandbox({ tools: catalog.tools });
const report = await sandbox.execute("return await tools.add({ a: 2, b: 3 });");
```

### Execution options

All fields are optional. Byte/count settings must be positive integers within
their supported ranges; [the reference](docs/reference.md#resource-limits) describes
validation and exact boundaries.

| Option                   | Default  | Controls                                                              |
| ------------------------ | -------- | --------------------------------------------------------------------- |
| `timeoutMs`              | 1,000 ms | Guest execution, including host-call waits                            |
| `totalTimeoutMs`         | Unset    | Parent deadline covering worker startup through completion acceptance |
| `signal`                 | Unset    | Caller cancellation                                                   |
| `memoryLimitBytes`       | 64 MiB   | QuickJS guest heap                                                    |
| `maxStackSizeBytes`      | 1 MiB    | QuickJS stack guard                                                   |
| `maxSourceBytes`         | 256 KiB  | Submitted UTF-8 source                                                |
| `maxOutputBytes`         | 256 KiB  | Final JSON return value or script-error message                       |
| `maxToolCalls`           | 100      | Total admitted tool calls                                             |
| `maxConcurrentToolCalls` | 10       | Outstanding tool calls                                                |

### Important boundaries

- Guest code has no host `process`, `Bun`, `require`, or `fetch`. Imports, TypeScript,
  and persistent guest state are not supported. Values cross boundaries through JSON.
- Successful execution drains started tool calls. Cancellation and failure end
  observation and request cooperative tool cancellation; started side effects may continue.
- Reports retain completed responses and mark unresolved calls as interrupted.
  They do not establish rollback or safe retry.
- Workers provide thread separation, not OS/process isolation. Host callbacks run
  on the main thread; synchronous work can delay cancellation and deadlines.
- Guest memory and final output are bounded. Total host/WASM memory, tool payloads,
  and retained response bytes are not. Each execution pays fresh worker/VM startup cost.

## How it fits together

```text
src/
  codemode/
    index.ts       public API
    types.ts       execution options, results, and call contracts
    sandbox.ts     CodemodeSandbox and one-shot execute
    errors.ts      host infrastructure errors
    tools.ts       host-tool contracts, validation, serialization
    catalog.ts     metadata and discovery
    runtime/       WorkerExecution, QuickJS engine, bridges, and worker protocol
  mcp/
    index.ts       public API
    types.ts       discovery options
    catalog.ts     MCP discovery and tool adaptation
    schema.ts      MCP JSON Schema compilation
```

MCP depends on codemode's public tool contract. Codemode has no MCP dependency.
Import module entry points in application code; runtime files are implementation details.

```text
Main app: CodemodeSandbox.execute → admission → WorkerExecution.run
                      ↕ tool requests and serialized responses
Worker:   engine → prepare guest script → pump jobs and enforce guest deadline
                      ↕ owned QuickJS handles and deferred promises
Guest:    submitted async function → tools[name](args)
```

The parent owns tool implementations, execution outcomes, and retained calls.
The engine owns the VM and guest handles. The worker bridge correlates transport
replies; the guest bridge settles guest promises.

## Development

`bun run check` runs typechecking, Oxlint, Oxfmt checks, and all tests.
Run `bun run format` to format changes. Run both examples when changing their paths.

- [Project conventions](AGENTS.md)
- [Testing conventions and focused commands](tests/README.md)
- [Full API and behavioral reference](docs/reference.md)
- [Architecture and ownership](docs/reference.md#architecture)

## Status and milestones

The core sandbox and MCP adapter are implemented. This is a learning project,
not a production-hardened sandbox.

Completed slices, in order:

1. Synchronous QuickJS execution.
2. Async host-call bridge with explicit `ToolResult`.
3. Private guest prelude and wrapper validation.
4. Worker-backed execution.
5. Worker-backed host tools, catalog, and discovery.
6. Guest and opt-in parent deadlines.
7. Caller and cooperative host-tool cancellation.
8. Execution reports with retained responses and interruption reasons.
9. Memory, stack, and source limits.
10. Tool-call and concurrency limits.
11. Final guest-output limits.
12. MCP client adapter with bounded discovery and stdio lifecycle coverage.
13. Typed Standard Schema tools and compiled MCP input validation.

Next: soak/fault testing, latency/memory measurements, and reference comparisons;
then revisit payload/retention bounds using integration evidence.
