# @cmg/codemode

A standalone, Bun-only JavaScript execution library. Supply application tools,
then run JavaScript that composes those tools inside QuickJS in a fresh worker.
MCP is optional: tools can call your own services, local operations, or APIs.

The package name is provisional. Nothing has been published. This is a working
MVP, not a production-hardened or OS-isolated sandbox.

## Usage

```ts
import { CodemodeSandbox, ToolResult } from "@cmg/codemode";

const sandbox = new CodemodeSandbox({
  tools: { answer: () => ToolResult.success(42) },
  timeoutMs: 1_000,
});

const report = await sandbox.execute("return await tools.answer();");
console.log(report.result); // { ok: true, value: 42 }
console.log(report.calls);
```

Submit an async function body: top-level `await` and `return` work. Import the
package root; `runtime/` is private implementation, not a supported deep import.
Requires Bun 1.4.2; npm installation does not imply Node compatibility.

## Responsibilities and ownership

- `CodemodeSandbox` snapshots tool bindings and validates fixed limits at construction.
- Each execution owns a fresh worker, QuickJS VM, budget, and report. Executions can overlap.
- The application owns tool capabilities, their external connections, and any side effects.
- Host callbacks run on the main thread, receiving unknown arguments and an `AbortSignal`.
- The private guest prelude owns JavaScript promises. One native dispatcher relays JSON
  calls to the host; replies settle those promises without per-call native deferred handles.
- Execution settles only after worker cleanup. No reusable VM or sandbox `close()` is needed.

This package does not connect to MCP, read configuration files, install process
signal handlers, perform authentication, or run an agent/model loop.

## Public API

| API                                               | Contract                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `CodemodeSandbox`                                 | Fixed tools and resource policy; `execute(code, { signal }?)` runs one execution     |
| `ToolResult.success(value)` / `.failure(message)` | Explicit tool success or deliberately public failure                                 |
| `defineTool` / `validateTool`                     | Bind Standard Schema input validation to typed handlers                              |
| `ToolCatalog.create`                              | Select tool callbacks and discovery metadata                                         |
| `createDiscoveryTools`                            | Local `searchTools` and `describeTool` callbacks; applications choose their exposure |
| `SandboxLimits`                                   | Defaults and maximum supported resource settings                                     |
| `SandboxExecutionError`                           | Infrastructure rejection with an observed call snapshot and host-only cause          |

Core contracts include `SandboxTool`, `ToolContext`, `SandboxOptions`,
`ExecuteOptions`, `SandboxResult`, `ExecutionReport`, and `CallOutcome`.

## Failures, cancellation, and completion

- Script errors, deadlines, cancellation, and source/output/call limits resolve in `report.result`.
- Infrastructure failures reject with `SandboxExecutionError`; invalid policy throws `RangeError`.
- `ToolResult.failure(message)` becomes a catchable guest rejection. Unexpected callback
  exceptions become `Host tool failed.`; private exception messages are not exposed.
- Successful execution drains calls already started, including `Promise.race` losers.
- Cancellation/failure ends observation and requests cooperative cancellation. It does not
  roll back side effects or establish that retrying is safe. Late completions cannot access a closed VM.
- Completed calls retain serialized responses; interrupted calls explain why observation stopped.

## Limits and boundaries

| Setting                          | Default                                                                     |
| -------------------------------- | --------------------------------------------------------------------------- |
| Guest deadline `timeoutMs`       | 1,000 ms, after VM creation and including host waits                        |
| Parent deadline `totalTimeoutMs` | Unset; when supplied, includes worker startup through completion acceptance |
| Guest heap / stack               | 64 MiB / 1 MiB                                                              |
| Source / final output            | 256 KiB / 256 KiB, measured in UTF-8 bytes                                  |
| Total / outstanding calls        | 100 / 10                                                                    |

Limits belong to the constructor, not individual execution requests. The guest has
no host `process`, `Bun`, filesystem, `fetch`, or imports. Arguments and results
cross JSON; an undefined final return becomes null, while undefined tool results
remain undefined. Guest built-ins remain mutable; private protocol functions are
captured before submitted code runs.

Workers provide thread separation, not OS/process isolation. Tool payloads,
retained report bytes, aggregate concurrent memory, and synchronous host work are
not bounded by guest limits. Each execution pays worker/VM startup cost.

## Distribution

The build emits ESM JavaScript, declarations, and the worker into `dist/` without
bundling dependencies. Normal consumers use the compiled package export. The
`development` condition selects source only inside the repository checkout.

## Development

From the workspace root:

```sh
bun run --cwd packages/codemode test
bun run --cwd packages/codemode check
```

This package owns its execution, worker, VM, discovery, and tool-validation tests
under `tests/`, including subprocess fixtures and ownership helpers.
See [testing conventions](../../docs/testing.md) and the
[behavioral reference](../../docs/reference.md) for detailed semantics and fault handling.
