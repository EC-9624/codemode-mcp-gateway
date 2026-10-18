# @codemode-mcp-gateway/codemode

A Bun-only library for running JavaScript inside QuickJS, a JavaScript engine
compiled to WebAssembly. Supply host tools; scripts can call them but cannot
access the host's filesystem, network, or process directly. MCP is not required.

## Setup

Source/package use requires **Bun 1.4.3**. This package is not published to a registry.
From the full workspace root:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run --cwd packages/codemode example
bun run --cwd packages/codemode example:contracts
```

The minimal example returns `42`; advanced examples demonstrate intentional
failure/cancellation and recovery. Examples live in `packages/codemode/examples/`
in the repository and are not shipped in tarballs. For local compiled consumers,
build from the workspace root before packing; import the package root without the
`development` condition. The snippets and contracts here are self-contained for
installed readers; `dist/index.d.ts` contains the supported public signatures.

## Usage

```ts
import { CodeExecutor, ToolResult } from "@codemode-mcp-gateway/codemode";

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
sandbox without calling `close()`. Default tools and limits are fixed at construction,
and up to four executions may overlap by default, including their worker cleanup.

### Per-execution tools

Hosts with changing catalogs can reuse one executor and supply tools for each run:

```ts
const sandbox = new CodeExecutor({ maxConcurrentExecutions: 4 });
const report = await sandbox.execute(code, { tools: currentCatalog.tools, signal });
```

Supplied tools replace constructor defaults for that execution; they are not merged.
An empty `{}` exposes no tools. Omitting `tools` (or passing `undefined`) uses the
constructor snapshot. Bindings are copied synchronously after admission, before any
worker starts, so later registry mutations cannot change an active execution. This
copies callbacks, not their external resources or closure state; the host owns those.
All runs use the same executor budget regardless of their tool snapshots.

Pre-aborted, oversized, and over-capacity submissions do not read execution tools.
Registry access failures reject with host-only `SandboxExecutionError` diagnostics,
start no worker, and release admission. Tool snapshotting is outside execution deadlines.

Import the package root; runtime deep imports are unsupported. The root shortcut
`bun run example` runs the minimal example. Use the package's `example:contracts`
command for the advanced behaviors described below.

The gateway's standalone build embeds the executor's worker as a second entrypoint
named `worker.js` beside the executable in Bun's virtual filesystem, and embeds
the QuickJS WASM assets. Custom standalone hosts must preserve this worker name
and supply the corresponding embedded WASM loading; copying only an emitted
executor module is not a complete application distribution.

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
Use `ToolResult.failure(message, { cause })` to attach an original diagnostic cause
to a deliberately public failure. Only the message crosses into the guest.

To see those exceptions on the host, pass `onToolException` to the constructor:

```ts
const sandbox = new CodeExecutor({
  tools,
  onToolException: ({ callId, name, cause }) => console.error(name, callId, cause),
});
```

It is called synchronously with the original thrown or attached `cause` while the
execution is still running. Failures after the outcome is fixed, such as tools rejecting on
abort, are not reported. If the observer throws, the execution rejects with
`SandboxExecutionError` carrying that error.

An `execute(code, { onToolException })` observer overrides the constructor default
for that execution only, allowing concurrent callers to retain their own diagnostic
context. It has the same private-cause and observer-failure contract.

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

Successful execution drains active and queued calls and queued guest jobs, including
unawaited calls and `Promise.race` losers. Failure or cancellation stops observing
unfinished calls, discards undispatched queued calls, and aborts their shared tool signal. Tools must stop cooperatively;
the sandbox awaits worker cleanup, not cancelled callbacks. It cannot roll back side effects.

## Limits and boundaries

| Option                    | Default | Bounds                                                                                    |
| ------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `timeoutMs`               | Unset   | Optional deadline after VM/bridge setup; includes parsing, queued calls, and host waits   |
| `totalTimeoutMs`          | Unset   | Worker construction through acceptance of completion                                      |
| `memoryLimitBytes`        | 256 MiB | QuickJS guest heap                                                                        |
| `maxStackSizeBytes`       | 1 MiB   | QuickJS stack guard; maximum 4 MiB                                                        |
| `maxSourceBytes`          | 256 KiB | Submitted body's UTF-8 bytes                                                              |
| `maxOutputBytes`          | 256 KiB | Final JSON value or script-error message, not tool payloads                               |
| `maxToolCalls`            | 100     | Total admitted tool calls, including queued calls                                         |
| `maxConcurrentToolCalls`  | 10      | Active tool calls; additional calls wait in invocation order                              |
| `maxConcurrentExecutions` | 4       | Active executions per executor, including worker cleanup; excess submissions are rejected |

Both deadlines are unset by default; set a deadline or supply cancellation for
work that may not terminate. Configured limits must be positive integers; zero
and infinity do not disable them. A total
deadline can cover startup, but is not a hard response-latency cap: synchronous
host work can delay enforcement, and cleanup may finish after the deadline.
All options use positive timer-sized integers up to 2147483647; the stack guard
has a lower maximum of 4 MiB. Memory limits bound the guest heap, not process RSS.

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
With both defaults, four admitted executions can each have ten active tool calls,
with additional calls queued within each execution's 100-call total budget.

Workers provide thread separation, not OS/process isolation. Tool payloads, temporary
serialization/transport allocations, and aggregate host/WASM memory are not bounded
by guest limits. Call reports contain metadata only; the final guest result may
include tool data the script deliberately returns.
This is a working MVP, not a production-hardened sandbox.

## Tools and discovery

- `defineTool` binds Standard Schema validation and exports an
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

Native schemas must implement both Standard Schema and Standard JSON Schema.
`defineTool` exports the input schema once; transforms determine the handler's
output type. Export/copy failures throw before execution. JSON boundary semantics
apply: BigInt/circular values cannot cross; getters and `toJSON` participate in
conversion. Exact public signatures are included in `dist/index.d.ts`.

## How it works

QuickJS executes synchronously. A script such as `while (true) {}` on the host
thread would block the application's event loop, so each admitted execution runs
in a fresh worker with its own VM. The host keeps the tool callbacks and call records.

```text
guest: tools.answer() -> private JSON call envelope
worker: validate and admit -> queue until a slot is free -> post request to host
host: invoke callback -> serialize and record ToolResult -> post reply
worker: settle guest promise -> release slot and dispatch next queued call -> pump guest jobs
guest: continue after await -> serialize final return value
```

The engine explicitly pumps QuickJS's promise job queue. It yields between batches
and waits for replies when idle. The private prelude holds the resolver map and
captures protocol functions before submitted code runs; guest built-ins remain mutable.
Arguments and results cross JSON, not shared object references. An undefined final
return becomes `null`; an undefined tool result remains `undefined`.

The host selects the outcome, fixes the call snapshot, and awaits worker termination.
In the repository, `src/runtime/execution.ts`, `engine.ts`, and `guest-bridge.ts`
explain supervisor, VM, and bridge ownership. Those modules are internal, not exports.
This package does not own tool connections, MCP setup, process signals, or an agent loop.

## Distribution

The provisional package name has not been published. Builds emit ESM JavaScript,
declarations, and the worker into `dist/`. The QuickJS SDK JavaScript is bundled
with a WASM memory-view fix for SDK 0.32.0; WASM variants and other
dependencies remain external. This ensures the fix reaches standalone consumers
without lifecycle scripts or consumer patches. See [third-party notices](THIRD_PARTY_NOTICES.md). Installed
consumers use compiled exports; repository scripts select source with the
`development` condition. Node compatibility is not supported.

## Development

From the workspace root:

```sh
bun run --cwd packages/codemode test
bun run --cwd packages/codemode check
```

The unit is a public module: flat `tests/*.test.ts` exercise `CodeExecutor`,
`ToolCatalog`, `defineTool`, and `validateTool` through `@codemode-mcp-gateway/codemode`. Sandbox
subjects are split by contract (tools, limits, cancellation, reports), not by
implementation layers. Tests use real QuickJS and workers.

The private ownership/fault probes explain why their observations cannot be made
through `execute()`: VM handles, original worker-local causes, independent admission,
transport listeners, and controlled cleanup races. Process fixtures separately prove
actual exit; `fixtures/packaged-codemode.ts` checks the installed public package.
See the repository's `packages/codemode/tests/README.md` for named surviving contracts
and the reasons for each private exception.

Repository-only references: `docs/testing.md` and `docs/reference.md` expand testing
conventions and edge cases; they are not shipped in this package.
