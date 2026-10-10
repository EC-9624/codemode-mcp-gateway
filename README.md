# MCM

A code-mode sandbox developed in small, explainable slices toward production
readiness. We implement execution and the host-call bridge ourselves, using
QuickJS as the JavaScript engine. Pi and Executor are source references, not
runtime dependencies. Learning shapes the delivery, not the final scope.

## Run

Requires the Bun version pinned in `.bun-version`. Bun is the only supported host
runtime for now.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run example
bun run check
```

## Usage

`src/sandbox.ts` is the public entry point.

```ts
import { execute, ToolResult } from "./src/sandbox";

await execute("return 1 + 2;");
// { ok: true, value: 3 }

await execute('throw new Error("Something failed");');
// { ok: false, error: { kind: "script", message: "Something failed" } }

await execute("return await tools.answer();", {
  answer: async () => ToolResult.success(42),
});
// { ok: true, value: 42 }

await execute("while (true) {}", {}, { timeoutMs: 100 });
// { ok: false, error: { kind: "timeout", message: "Execution exceeded the 100 ms limit." } }

await execute("while (true) {}", {}, { timeoutMs: 1000, totalTimeoutMs: 100 });
// { ok: false, error: { kind: "timeout", message: "Execution exceeded the 100 ms total limit." } }
```

Input is the body of an async function, not an expression or a module. Each call
runs in a fresh worker with a fresh QuickJS runtime and context. Only explicitly
supplied tools are exposed, on a frozen, null-prototype `tools` object that is
both the function parameter and `globalThis.tools`. `process`, `Bun`, `require`,
and `fetch` are not exposed.

Tool callbacks receive `unknown` arguments and must validate their domain inputs.
They return `ToolResult.success(value)` or `ToolResult.failure(publicMessage)`
rather than throwing validation errors. Guests receive ordinary values or
catchable promise rejections. Failure-shaped data wrapped in `success` remains
ordinary data.

`timeoutMs` defaults to 1000. Optional `totalTimeoutMs` adds a parent deadline
covering startup through acceptance of completion. Both budgets must be integers
from 1 to 2147483647; invalid budgets reject with a `RangeError` before a worker
starts. Either deadline can win; neither must be larger than the other. Omitting
`totalTimeoutMs` retains the guest-only deadline.

The total budget is not a hard response-latency cap: synchronous main-thread work
can delay enforcement, and worker termination is awaited after an outcome is chosen.

### Catalog and discovery

The app owns tool metadata and implementations. `ToolCatalog.create` snapshots
callback bindings, names, and descriptions from a definition record. Input
schemas are descriptive metadata, not validators. Schema objects remain
host-owned and should be treated as read-only.

```ts
import { createDiscoveryTools, execute, ToolCatalog, ToolResult } from "./src/sandbox";

const catalog = ToolCatalog.create({
  answer: {
    description: "Return the answer to the example question",
    execute: () => ToolResult.success(42),
  },
});

catalog.search("answer"); // [{ name: "answer", description: "..." }]
catalog.describe("answer"); // metadata; undefined for an unknown name

const discovery = createDiscoveryTools(catalog);
await execute(
  `
  const matches = await tools.searchTools({ query: "answer" });
  const name = matches[0].name;
  const description = await tools.describeTool({ name });
  return { description, value: await tools[name]() };
`,
  {
    ...catalog.tools,
    searchTools: discovery.searchTools,
    describeTool: discovery.describeTool,
  },
);
```

- Search matches whitespace-separated query terms against names and descriptions,
  case-insensitively. More distinct matching terms rank first; ties retain catalog
  order. Blank or unmatched host queries return an empty list.
- Search and description lookup return names, descriptions, and any input schema,
  never implementations or extra definition fields. Discovery does not invoke tools.
- Discovery callbacks are ordinary tools. Invalid requests and missing names
  produce deliberately public tool failures.
- The app chooses discovery names, so it can expose `findTools: discovery.searchTools`
  when its catalog already contains a tool named `searchTools`.
- Names are preserved exactly: use `tools["billing.listInvoices"]` for names that
  are not JavaScript identifiers.

Only callable names go to the worker at startup; metadata reaches the guest when
discovery returns it. A future MCP adapter can provide definitions and callbacks
without teaching the engine about MCP.

## Architecture

**Guest** means JavaScript inside QuickJS. **Worker** means the Bun thread
embedding QuickJS. **Main app** means the main thread holding tool implementations
and the catalog. The entry point determines where a module runs; source files stay
in a flat `src/` directory.

```text
Main app
  sandbox.ts: public exports
  worker-execution.ts: execute(...), parent deadline, and the worker supervisor
  tool.ts: callback invocation and result serialization
  tool-catalog.ts: metadata and discovery
       |
       | worker messages: call IDs, names, JSON payloads
       v
Worker thread (Bun)
  worker-entry.ts: decode startup data, assemble the engine and tool connection
  worker-tool-bridge.ts: correlate calls with main-thread replies
       |
  sandbox-engine.ts: own the VM, validate and compile source, pump jobs, enforce the deadline
  guest-tool-bridge.ts: install guest callbacks and settle guest promises
       |
       | VM boundary: QuickJS handles and deferred promises
       v
QuickJS guest
  private prelude: JSON conversion and public tools.<name> wrappers
  submitted code: await tools.someTool(args)
```

Supporting modules: `runtime.ts` creates a VM with memory and stack limits;
`worker-protocol.ts` and `sandbox-result.ts` define shared data contracts;
`listener.ts` registers listeners whose removal is owned by a cleanup stack.

A tool call travels up and its reply travels back down:

```text
guest: tools.add(args) -> prelude serializes arguments to JSON text
worker: allocate call ID, post tool-call { callId, name, argsJson }
main: decode and parse arguments once, validate the call, invoke the callback,
      serialize the ToolResult, post tool-result { callId, result }
worker: decode reply, match call ID, resolve or reject the guest promise
worker: pump QuickJS jobs -> prelude decodes the result -> guest resumes
```

Resolving a guest promise queues continuations; `runtime.executePendingJobs()`
runs them. The job pump processes at most 100 jobs per turn and yields to host
timers and I/O between batches.

### Ownership

| Owner                        | Resources                                                            |
| ---------------------------- | -------------------------------------------------------------------- |
| Main-thread supervisor       | Worker lifecycle, listeners, parent timer/interrupt flag, dispatch   |
| Worker entry's cleanup stack | Transport listeners and pending remote replies                       |
| Engine                       | QuickJS context and runtime, deadline, and bridge scope              |
| Guest bridge                 | Borrows the context and scope; deferred handles belong to that scope |
| Main app's catalog           | Callback bindings and metadata; no VM or worker resources            |

- On normal scope exit or unwinding, `using` disposes resources in reverse declaration order.
  QuickJS handles point into WASM memory; host garbage collection does not
  release them. Forced worker termination may skip this worker-side cleanup.
- `createVm` transfers the context, which owns its runtime, only after setup
  succeeds. A factory-local `using` would dispose it before the caller could use it.
- Promise resolvers outlive the callback that creates them, so the bridge `Scope`
  owns them for the execution. Settlement checks that the scope is alive before
  touching the VM, so late host completions never access a closed VM.
- Error reporting borrows the thrown handle and disposes only owned promise-state
  handles; the SDK's `dump` consumes promise handles.
- The supervisor removes message, message-error, and exit listeners before
  terminating the worker. The error listener stays until termination settles, so
  late errors cannot become unhandled EventEmitter errors. Partial setup unwinds.
- The guest bridge's `pendingCalls` tracks work until guest promises settle;
  `failure` records the first private infrastructure failure and `failureSignal`
  wakes the engine. The worker bridge's `pendingReplies` correlates call IDs with
  main-thread replies.

## Contracts

### Results and failures

- Script errors and timeouts resolve to `SandboxResult` with kind `script` or
  `timeout`. Thrown strings become the message; other values without a string
  `message` produce a generic message. Thrown promises are opaque values, not
  awaited or unwrapped.
- `ToolResult.failure(message)` is the only way a host message reaches the guest.
  Exceptions thrown by a callback become `Host tool failed.` without exposing
  private messages or stacks. Scripts can catch tool rejections and continue.
- Infrastructure failures reject the host promise and never become catchable tool
  failures: parser and VM allocation/settlement failures, protocol violations,
  transport failures, worker crashes, and premature exit. They are not retried
  against the VM.
- Within the worker, infrastructure failures keep their original cause. Across the
  worker boundary, the worker sends only a controlled failure category and the
  supervisor rejects with a new error; worker exception messages, stacks, and
  identity are not transferred. Exceptions from local worker construction and
  termination propagate directly.
- Synchronous guest-bridge exceptions are recorded before the SDK can turn them
  into catchable guest errors. The interrupt handler observes the failure, and the
  engine checks it after guest execution, job pumping, and error conversion, so
  guest `try/catch`, loops, or error getters cannot replace it with a script result.

### JSON conversion

Arguments, tool results, and return values cross through JSON, so objects and
executable methods are never shared between host and guest.

- Native semantics apply: undefined object properties are omitted; undefined array
  entries and non-finite numbers become null. An absent or undefined return
  becomes null; an undefined tool result stays undefined.
- Guest return values and arguments convert inside the VM, including getters and
  `toJSON`. The prelude captures native JSON functions before user code runs, so
  guest mutation of `JSON` or `Promise.prototype.then` does not affect conversion.
- Tool results convert on the main thread. Throwing getters or `toJSON` hooks and
  unsupported values produce the public `Tool result is not JSON-serializable.`
- BigInt, circular values, and unsupported top-level values fail as script errors.
  Unsupported tool arguments fail before dispatch.
- Promise and thenable returns are awaited with native guest semantics.

### Completion and deadline

- Successful scripts wait for all started host calls and queued guest jobs,
  including unawaited calls, race losers, and calls started by `toJSON`. Awaiting
  one promise twice does not dispatch twice; `Promise.race` does not cancel losers.
- Draining calls is not proof that they succeeded: unhandled tool rejections
  follow native promise semantics and are not audited.
- A pending guest promise with no queued jobs or host calls fails explicitly
  instead of hanging.
- An uncaught script failure or timeout ends execution without waiting for
  unrelated callbacks. Late results are dropped before conversion or posting.
- One monotonic deadline covers source validation, prelude setup, execution, guest
  jobs, and host waits. It starts after worker startup, WASM loading, VM creation,
  and tool installation. A worker timer wakes idle execution; the QuickJS interrupt
  handler stops running guest computation.

### Parent-supervised deadline

`totalTimeoutMs` records a separate monotonic deadline before registry snapshotting
and worker construction. The parent owns its timer and a one-word shared interrupt
flag. The flag is supplied only to trusted worker code; it is never exposed to the guest.

```text
validate budgets -> record parent deadline -> construct worker -> supervise
  -> on messages and callback settlements: check the clock before continuing
  -> on expiry: select total-timeout result, close dispatch, set shared flag
  -> clear parent timer, remove normal listeners, request worker termination
  -> await termination, remove error listener, return timeout (or reject cleanup failure)
```

- Checking the clock during message handling prevents a queued completion or call
  from winning just because the timer callback has not run yet. Decoding and host
  result conversion are checked afterward too, because synchronous work can overrun.
- An outcome accepted before expiry remains final even if termination finishes
  after the deadline. Late replies and worker events cannot replace it.
- The QuickJS interrupt handler reads the flag with `Atomics.load`, so it can
  observe parent interruption during synchronous guest computation without waiting
  for a port message. An idle worker is shut down through termination.
- Bun exposes `worker.terminate()`, not a public shared interrupt flag; the shared
  flag here belongs to this application. In the pinned Bun version, termination
  requests a native VM stop and its promise is tied to the worker's `close` event.
  Neither a hard shutdown latency nor execution of worker-side cleanup is promised.
- Tests independently exercise shared-flag interruption, busy worker startup,
  guest computation, stalled startup, host waits, late events, and termination
  failures. Potentially stuck workers run in a subprocess with an outer test timeout;
  that subprocess must also exit after recovery and a successful execution.

### Guest boundary

Trusted setup and submitted code are compiled separately inside QuickJS:

```text
validate the complete async function wrapper with Acorn
  -> evaluate the trusted prelude factory
  -> factory captures raw callbacks and publishes only wrapped tools
  -> compile the validated user function in the VM's global scope
  -> private runner calls that function with tools and serializes its result
```

The user function cannot reach raw callbacks, captured JSON functions, or the
private runner through lexical scope, `eval`, or dynamic function constructors.

Acorn checks that the source is exactly the intended async arrow function with its
body boundaries intact. It does not rewrite the program or impose a JavaScript
subset. The check is necessary because QuickJS's native async-function constructor
accepted a wrapper-escape payload and dispatched a tool while constructing the
function. Malformed bodies fail before any user code or host call executes.

Guest built-ins remain mutable. VM-local `eval`/`Function`, closures, classes,
generators, and the guest-global `this` binding remain supported.

### Worker protocol

- Startup data and both message directions have typed decoders that accept
  `unknown` and return explicit success/failure unions. Structured cloning carries
  envelopes, JSON text/derived result data, and the optional shared interrupt buffer;
  no VM handles or functions cross threads. The buffer must contain one 32-bit word.
- JSON text is validated before dispatch or guest settlement. The main thread
  parses tool arguments once while decoding.
- Per-execution call IDs increase in dispatch order. The main thread rejects
  unknown tool names and invalid or replayed call IDs. Replies may complete out of
  order; the worker rejects unknown or duplicate replies.
- The first execution outcome wins; duplicate or late events do not resettle it.
  The supervisor awaits worker termination on success and failure, and termination
  failures reject the host promise.

## Limitations

- This is thread separation, not an OS or process sandbox. The trusted worker has
  Bun privileges; guest code runs only inside QuickJS.
- Limits cover the guest heap (64 MiB), stack (1 MiB), and deadline, not total
  host/WASM memory or model-facing output size.
- There is no worker pool: each execution pays worker startup and QuickJS loading.
- Worker startup is covered only when `totalTimeoutMs` is supplied. Without it,
  a stuck worker that neither reports nor exits can leave execution pending.
  There is no caller `AbortSignal` or hard response-latency guarantee; shutdown
  still depends on Bun's termination behavior.
- Synchronous host callbacks and result conversion run on the main thread and cannot
  be interrupted. The guest deadline checks source parsing after it returns;
  the parent can request worker termination meanwhile.
- Timeout or failure ends sandbox execution, not the host operation.
  Started operations may still finish or have side effects; there is no rollback,
  automatic retry, cancellation signal, or exactly-once guarantee.
- No imports, TypeScript, persistent state, or MCP integration yet.
- This is a learning project, not a production-hardened sandbox.

## Code style and checks

Code explains **How**, tests specify **What**, commit logs explain **Why**, and
code comments explain **Why not**. `AGENTS.md` defines the project-specific style
and ownership rules.

Oxfmt uses `.oxfmtrc.json`. Oxlint uses `.oxlintrc.json` with native rules and
`oxlint-tsgolint` for type-aware promise and unsafe-operation checks; bare `void`
does not exempt an unhandled promise. Lint also enforces named imports, type-only
import markers, `const`, and guard clauses. Import aliases, helper extraction,
narrow catches, and VM resource ownership remain review rules.

```sh
bun run format
bun run lint
bun run typecheck
```

Behavior tests use the public `execute`. Engine-level tests use
`tests/local-tools.ts` to run the real guest bridge on the test thread, which keeps
VM handles and original exceptions observable for ownership and fault tests.

## Milestones

1. Synchronous QuickJS execution.
2. Async host-call bridge with explicit `ToolResult`.
3. Private guest prelude and wrapper validation.
4. Worker-backed execution.
5. Worker-backed host tools, host-owned catalog, and discovery.
6. Configurable guest deadlines and opt-in parent-supervised deadlines/interruption.

Next:

1. Caller/tool cancellation, then retained call outcomes with unresolved calls marked uncertain.
2. Configurable memory and bounds on source, calls, concurrency, payloads, and output.
3. Schema-backed argument validation and one synthetic MCP upstream to the host catalog.
4. Soak/fault testing, latency/memory measurements, and reference comparisons.

Do not add a gateway framework before the sandbox behavior is understood.
