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
bun run example:server
bun run check
```

## Agent-facing MCP server

MCM exposes one MCP tool: **`execute({ code })`**. JavaScript can discover and call
tools from one upstream MCP server (stdio or Streamable HTTP), then return a processed JSON result.
The application owns the upstream connection and fixed sandbox policy.

Start with the included synthetic upstream:

```sh
bun run server examples/mcm.json
```

This command speaks MCP on stdin/stdout. `bun run example:server` runs a client
that starts it, discovers tools, executes a call, and shuts everything down.

Configure your coding agent to launch:

```sh
bun /absolute/path/to/mcm/src/server.ts /absolute/path/to/mcm/config.json
```

Configuration:

```json
{
  "upstream": {
    "transport": "stdio",
    "command": "bun",
    "args": ["mcp-server.ts"],
    "cwd": "./examples"
  },
  "sandbox": {
    "timeoutMs": 5000,
    "totalTimeoutMs": 10000,
    "maxToolCalls": 100
  }
}
```

`upstream.cwd` resolves relative to the configuration file; it defaults to that
file's directory. `upstream.env` optionally supplies string environment variables.
The CLI defaults to a 5-second guest deadline and a 10-second total deadline;
other limits match the table below. Configuration is validated at startup.

For a remote or local HTTP endpoint:

```json
{
  "upstream": {
    "transport": "http",
    "url": "https://example.com/mcp",
    "headers": {
      "Authorization": "Bearer {env:MCM_UPSTREAM_TOKEN}"
    }
  }
}
```

Omit `headers` for an unauthenticated endpoint. Header values can reference host
environment variables as `{env:NAME}`; missing variables fail startup before any
network request. Supply authentication through those headers, or use an
application-authenticated SDK client with `createMcpCatalog`. The CLI does not
perform OAuth login or store credentials. Existing command-only configurations
continue to select stdio when `transport` is omitted.

The agent submits discovery code through `execute`:

```js
return await tools.searchTools({ query: "add numbers" });
```

Matches contain exact names, descriptions, and input schemas. Inspect a tool with
`tools.describeTool({ name: "add" })`, then submit a call:

```js
const response = await tools.add({ a: 2, b: 3 });
return response.structuredContent.sum;
```

Response (also emitted as JSON text for clients that use text content):

```json
{
  "result": { "ok": true, "value": 5 },
  "calls": [{ "callId": 1, "name": "add", "status": "completed" }]
}
```

Call summaries omit retained tool-response bodies. Failures set MCP `isError: true`;
infrastructure failures use a controlled `sandbox` error. Request arguments accept
only `code`; limits stay server-owned. Discovery calls share the execution's call
budget. Upstream names `searchTools` and `describeTool` fail startup because they
conflict with the injected helpers.

Request cancellation reaches the sandbox and upstream calls. EOF, SIGINT, and
SIGTERM cancel active executions, await worker cleanup, and close the upstream
process. For HTTP it requests session deletion when a session ID was assigned,
then closes the connection; deletion has a 5-second request timeout. Stdout is
reserved for MCP; diagnostics and upstream stderr use stderr.

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

`CodemodeSandbox` validates configuration and snapshots tool bindings at construction.
The application owns this fixed policy. Each `sandbox.execute(code, { signal }?)`
gets a fresh worker, VM, call budget, and report; executions can overlap.
Request options contain only cancellation. Worker cleanup completes before each
execution settles.

Tool callbacks receive unknown arguments and an execution-scoped `AbortSignal`.
Use `defineTool` with a Standard Schema validator for typed handlers, or validate
inside the callback. `ToolResult.failure(message)` produces a catchable guest
rejection; unexpected callback exceptions produce a generic, private-error-safe rejection.

### Public API

| Export                                                         | Purpose                                                                |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `CodemodeSandbox`                                              | Fixed resource limits and reusable tool bindings                       |
| `SandboxLimits`                                                | Shared resource defaults and upper bounds                              |
| `sandbox.execute(code, { signal }?)`                           | Run code and return its result plus observed tool calls                |
| `ToolResult.success(value)` / `.failure(message)`              | Explicit host-tool outcomes                                            |
| `defineTool(definition)`                                       | Bind a typed Standard Schema validator to a handler                    |
| `validateTool(schema, handler, name?)`                         | Adapt a Standard Schema validator and typed handler to a host callback |
| `ToolCatalog.create(definitions)`                              | Snapshot tools and their discovery metadata                            |
| `createDiscoveryTools(catalog)`                                | Expose catalog search and description as host tools                    |
| `createMcpCatalog(client, options?)` (from `src/mcp`)          | Adapt a connected, application-owned MCP client                        |
| `createCodemodeServer({ catalog, sandbox? })` (from `src/mcp`) | Create an execute-only MCP server with in-script discovery             |
| `SandboxExecutionError`                                        | Host infrastructure failure carrying a cause and call snapshot         |

Script errors, timeouts, cancellation, and admission/output limits resolve in
`report.result`. Infrastructure failures reject with `SandboxExecutionError`;
invalid sandbox configuration throws `RangeError` during construction.

MCP composition uses the same tool contract:

```ts
import { CodemodeSandbox } from "./src/codemode";
import { createMcpCatalog } from "./src/mcp";

// The application owns the connected MCP SDK client and closes it when done.
const catalog = await createMcpCatalog(client);
const sandbox = new CodemodeSandbox({ tools: catalog.tools });
const report = await sandbox.execute("return await tools.add({ a: 2, b: 3 });");
```

### Sandbox configuration

Set limits on `new CodemodeSandbox({ tools, ...configuration })`; executions cannot
override them. All fields are optional. Byte/count settings must be positive integers within
their supported ranges; [the reference](docs/reference.md#resource-limits) describes
validation and exact boundaries.

| Option                   | Default  | Controls                                                              |
| ------------------------ | -------- | --------------------------------------------------------------------- |
| `timeoutMs`              | 1,000 ms | Guest execution, including host-call waits                            |
| `totalTimeoutMs`         | Unset    | Parent deadline covering worker startup through completion acceptance |
| `memoryLimitBytes`       | 64 MiB   | QuickJS guest heap                                                    |
| `maxStackSizeBytes`      | 1 MiB    | QuickJS stack guard                                                   |
| `maxSourceBytes`         | 256 KiB  | Submitted UTF-8 source                                                |
| `maxOutputBytes`         | 256 KiB  | Final JSON return value or script-error message                       |
| `maxToolCalls`           | 100      | Total admitted tool calls                                             |
| `maxConcurrentToolCalls` | 10       | Outstanding tool calls                                                |

Pass cancellation separately for each request:

```ts
const report = await sandbox.execute(code, { signal });
```

The standalone `execute(code, tools, options)` API has been removed. Construct a
sandbox with tools and limits once, then reuse its `execute` method.

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
  config.ts        application configuration and host HTTP header templates
  server.ts        stdio application: configuration, upstream connection, shutdown
  codemode/
    index.ts       public API
    types.ts       execution options, results, and call contracts
    limits.ts      shared resource policy
    sandbox.ts     fixed CodemodeSandbox configuration and execution admission
    errors.ts      host infrastructure errors
    tools.ts       host-tool contracts, validation, serialization
    catalog.ts     metadata and discovery
    runtime/       WorkerExecution, QuickJS engine, bridges, and worker protocol
  mcp/
    index.ts       public API
    types.ts       discovery/server options and compact public responses
    catalog.ts     MCP discovery and tool adaptation
    server.ts      execute-only MCP server
    schema.ts      MCP JSON Schema compilation
```

MCP depends on codemode's public tool contract. Codemode has no MCP dependency.
Import module entry points in application code; runtime files are implementation details.

```text
Main app: CodemodeSandbox.execute → admission → WorkerExecution.run
                      ↕ tool requests and serialized responses
Worker:   engine → prepare guest script → pump jobs and enforce guest deadline
                      ↕ one dispatcher and private settlement function, JSON envelopes
Guest:    private prelude owns promises → submitted async function → tools[name](args)
```

The parent owns tool implementations, execution outcomes, and retained calls.
The engine owns the VM and guest handles. The worker validates admitted call IDs
and relays replies; the private prelude correlates and settles ordinary guest
promises. There are no native deferred handles or worker reply promises per call.

## Development

`bun run check` runs typechecking, Oxlint, Oxfmt checks, and all tests.
Run `bun run format` to format changes. Run the affected examples when changing their paths.

- [Project conventions](AGENTS.md)
- [Testing conventions and focused commands](tests/README.md)
- [Full API and behavioral reference](docs/reference.md)
- [Architecture and ownership](docs/reference.md#architecture)

## Status and milestones

The core sandbox, MCP adapter, and execute-only stdio server are implemented. This is a learning project,
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
14. Fixed, constructor-owned sandbox policy and reusable tool bindings.
15. Execute-only MCP server with in-script discovery and a single upstream connection.
16. HTTP upstreams with host-supplied authentication and session cleanup.
17. Single-dispatcher guest protocol with prelude-owned promises and execution-level wakeups.

Next: soak/fault testing, latency/memory measurements, and reference comparisons;
then revisit payload/retention bounds using integration evidence.
