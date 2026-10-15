# @cmg/codemode

A Bun-only library for running JavaScript inside QuickJS, a JavaScript engine
compiled to WebAssembly. Supply host tools; scripts can call them but cannot
access the host's filesystem, network, or process directly. MCP is not required.

## Usage

```ts
import { CodeExecutor, ToolResult } from "@cmg/codemode";

const sandbox = new CodeExecutor({
  tools: { answer: () => ToolResult.success(42) },
  timeoutMs: 1_000,
});

const report = await sandbox.execute("return await tools.answer();");
console.log(report.result); // { ok: true, value: 42 }
console.log(report.calls);
// [{ callId: 1, name: "answer", status: "completed" }]
```

Submit the body of an async function: top-level `await` and `return` work, but
modules and TypeScript do not. Each execution has a fresh environment; reuse the
sandbox without calling `close()`. Tools and limits are fixed at construction,
and up to four executions may overlap by default, including their worker cleanup.

Requires Bun **1.4.2**. Import the package root; runtime deep imports are unsupported.
Run [the complete example](../../examples/basic.ts) with `bun run example` from
the workspace root.

## Results and failures

`execute()` returns `{ result, calls }`. Expected failures resolve rather than throw:

```ts
const failed = await sandbox.execute('throw new Error("Script failed");');
console.log(failed.result);
// { ok: false, error: { kind: "script", message: "Script failed" } }
```

| `result.error.kind` | Meaning                                                                      |
| ------------------- | ---------------------------------------------------------------------------- |
| `script`            | Invalid JavaScript, an uncaught exception, or a value that cannot cross JSON |
| `timeout`           | Guest or total deadline expired                                              |
| `cancelled`         | The caller's signal was aborted                                              |
| `limit`             | Execution capacity, source, final output, or tool-call policy was exceeded   |

Infrastructure failures reject with `SandboxExecutionError`, carrying host-only
diagnostics and the final call observations. Invalid constructor limits throw
`RangeError`; failures reading tool bindings throw `SandboxExecutionError`.

Tool callbacks receive unknown arguments and `{ signal }` on the host thread.
Return `ToolResult.failure(message)` for a deliberately public, catchable guest
rejection. Unexpected callback exceptions become `Host tool failed.` without
exposing their messages or stacks. Failure-shaped values inside `success()` remain data.

Call records stay in invocation order and contain only `callId`, `name`, `status`,
and an interruption `reason` when applicable. `completed` means the parent serialized
a response before execution ended, including tool failures; it does not establish
guest receipt, external success, or safe retry. Scripts receive complete tool values
and public failures, but call records never retain their bodies or arguments.

**API change:** completed calls no longer have a `result` field, including calls on
`SandboxExecutionError`. To expose selected tool data, return it explicitly from the
script through `report.result`. There is no response-retention setting.

### Cancellation and completion

Pass cancellation per execution, not to the constructor:

```ts
const cancelled = await sandbox.execute("return await tools.answer();", {
  signal: AbortSignal.abort(),
});
console.log(cancelled.calls); // [] — no worker or tool call started
```

Successful execution drains all started calls and queued guest jobs, including
unawaited calls and `Promise.race` losers. Failure or cancellation stops observing
unfinished calls and aborts their shared tool signal. Tools must stop cooperatively;
the sandbox awaits worker cleanup, not cancelled callbacks. It cannot roll back side effects.

## Limits and boundaries

| Option                    | Default  | Bounds                                                                                    |
| ------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `timeoutMs`               | 1,000 ms | Source parsing through completion, after VM/bridge setup; includes host waits             |
| `totalTimeoutMs`          | Unset    | Worker construction through acceptance of completion                                      |
| `memoryLimitBytes`        | 64 MiB   | QuickJS guest heap                                                                        |
| `maxStackSizeBytes`       | 1 MiB    | QuickJS stack guard; maximum 4 MiB                                                        |
| `maxSourceBytes`          | 256 KiB  | Submitted body's UTF-8 bytes                                                              |
| `maxOutputBytes`          | 256 KiB  | Final JSON value or script-error message, not tool payloads                               |
| `maxToolCalls`            | 100      | Total admitted tool calls                                                                 |
| `maxConcurrentToolCalls`  | 10       | Outstanding tool calls; excess calls are rejected, not queued                             |
| `maxConcurrentExecutions` | 4        | Active executions per executor, including worker cleanup; excess submissions are rejected |

Limits must be positive integers; zero and infinity do not disable them. A total
deadline can cover startup, but is not a hard response-latency cap: synchronous
host work can delay enforcement, and cleanup may finish after the deadline.
See [exact boundaries](../../docs/reference.md#resource-limits).

### Execution capacity

`maxConcurrentExecutions` belongs to each `CodeExecutor`, not to individual agents
or the entire process. Pre-aborted and oversized-source submissions are handled
before admission. At capacity, `execute()` immediately resolves with:

```ts
{
  result: {
    ok: false,
    error: {
      kind: "limit",
      resource: "executions",
      maximum: 4,
      message: "Executor reached the 4 concurrent-execution limit.",
    },
  },
  calls: [],
}
```

No worker or host tool is started for that submission, and it is not queued or
retried. Capacity is reserved before worker construction and held until cleanup
settles. Construction failures release the reservation. If termination fails while
the worker is still alive, the infrastructure error rejects as usual, but the slot
stays occupied until actual worker exit. Cancellation does not wait for uncooperative
host callbacks; those may outlive the worker and its slot.

This is separate from `maxConcurrentToolCalls`, which applies inside each execution.
With both defaults, four admitted executions can each have ten outstanding tool calls.

Workers provide thread separation, not OS/process isolation. Tool payloads, temporary
serialization/transport allocations, and aggregate host/WASM memory are not bounded
by guest limits. Call reports contain metadata only; the final guest result may
include tool data the script deliberately returns.
This is a working MVP, not a production-hardened sandbox.

## Tools and discovery

- [`defineTool`](src/catalog.ts) binds Standard Schema validation and exports an
  input JSON Schema for discovery. The handler receives the validated arguments,
  including transformations. `validateTool` adapts a validator without requiring JSON export.
- `ToolCatalog.create` snapshots callback bindings and public metadata. Manually
  supplied `inputSchema` is descriptive; it does not validate calls by itself.
- `createDiscoveryTools` supplies ordinary `searchTools` and `describeTool`
  callbacks. The application chooses whether and under which names to expose them.
  `searchTools({ query, limit?, offset? })` returns `{ tools, total, nextOffset }`:
  five name/short-description previews by default, without schemas. Read `page.tools`
  rather than the previous metadata array. Use `describeTool({ name })` for a selected
  tool's complete description/schema; follow `nextOffset` for additional matches.
  Host `catalog.search()` remains an unpaged list of full metadata. Name matches rank
  ahead of description-only matches, with stable ties.
- `SandboxLimits` exposes shared defaults and upper bounds.

See [validated tools](../../docs/reference.md#validated-tool-contracts) and
[discovery](../../docs/reference.md#catalog-and-discovery) for examples. Exact
signatures and field contracts live in the [public exports](src/index.ts) and
[types](src/types.ts).

## How it works

QuickJS executes synchronously. A script such as `while (true) {}` on the host
thread would block the application's event loop, so each admitted execution runs
in a fresh worker with its own VM. The host keeps the tool callbacks and call records.

```text
guest: tools.answer() -> private JSON call envelope
worker: validate and admit -> post request to host
host: invoke callback -> serialize and record ToolResult -> post reply
worker: settle guest promise -> release call slot -> pump guest jobs
guest: continue after await -> serialize final return value
```

The engine explicitly pumps QuickJS's promise job queue. It yields between batches
and waits for replies when idle. The private prelude holds the resolver map and
captures protocol functions before submitted code runs; guest built-ins remain mutable.
Arguments and results cross JSON, not shared object references. An undefined final
return becomes `null`; an undefined tool result remains `undefined`.

The host selects the outcome, fixes the call snapshot, and awaits worker termination.
The [supervisor](src/runtime/execution.ts), [engine](src/runtime/engine.ts), and
[guest bridge](src/runtime/guest-bridge.ts) explain their lifetimes beside the code.
This package does not own tool connections, MCP setup, process signals, or an agent loop.

## Distribution

The provisional package name has not been published. Builds emit ESM JavaScript,
declarations, and the worker into `dist/` without bundling dependencies. Installed
consumers use compiled exports; repository scripts select source with the
`development` condition. Node compatibility is not supported.

## Development

From the workspace root:

```sh
bun run --cwd packages/codemode test
bun run --cwd packages/codemode check
```

The unit is a public module: flat `tests/*.test.ts` exercise `CodeExecutor`,
`ToolCatalog`, `defineTool`, and `validateTool` through `@cmg/codemode`. Sandbox
subjects are split by contract (tools, limits, cancellation, reports), not by
implementation layers. Tests use real QuickJS and workers.

The private ownership/fault probes explain why their observations cannot be made
through `execute()`: VM handles, original worker-local causes, independent admission,
transport listeners, and controlled cleanup races. Process fixtures separately prove
actual exit; `fixtures/packaged-codemode.ts` checks the installed public package.
See the [test ownership and migration map](tests/README.md) for named surviving contracts
and the reasons for each private exception.

See [testing conventions](../../docs/testing.md) and the
[behavioral reference](../../docs/reference.md) for detailed semantics and fault handling.
