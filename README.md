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

Oxlint enforces blank lines after guards/control-flow blocks, before standalone
returns, and around multiline declarations. Apply spacing fixes with
`bun run lint --fix`, then run `bun run format`. Keep logical phases separated
manually, especially test setup, execution, and assertions.

## Usage

`src/sandbox.ts` is the public entry point.

```ts
import { execute, ToolResult } from "./src/sandbox";

await execute("return 1 + 2;");
// { result: { ok: true, value: 3 }, calls: [] }

await execute('throw new Error("Something failed");');
// { result: { ok: false, error: { kind: "script", message: "Something failed" } }, calls: [] }

await execute("return await tools.answer();", {
  answer: async () => ToolResult.success(42),
});
// {
//   result: { ok: true, value: 42 },
//   calls: [{ callId: 1, name: "answer", status: "completed", result: { ok: true, json: "42" } }]
// }

(await execute("while (true) {}", {}, { timeoutMs: 100 })).result;
// { ok: false, error: { kind: "timeout", message: "Execution exceeded the 100 ms limit." } }

(await execute("while (true) {}", {}, { timeoutMs: 1000, totalTimeoutMs: 100 })).result;
// { ok: false, error: { kind: "timeout", message: "Execution exceeded the 100 ms total limit." } }
```

Input is the body of an async function, not an expression or a module. Each call
runs in a fresh worker with a fresh QuickJS runtime and context. Only explicitly
supplied tools are exposed, on a frozen, null-prototype `tools` object that is
both the function parameter and `globalThis.tools`. `process`, `Bun`, `require`,
and `fetch` are not exposed.

Tool callbacks receive `unknown` arguments and a host-only `ToolContext` containing
an execution-scoped `signal`. Existing callbacks can ignore the second argument.
Callbacks must validate their domain inputs.
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

### Resource limits

All settings are optional, flat fields on `ExecuteOptions`. Override only what you need:

```ts
await execute(code, tools);
await execute(code, tools, { memoryLimitBytes: 128 * 1024 * 1024 });
```

| Option              | Default             | Applies to                                                      |
| ------------------- | ------------------- | --------------------------------------------------------------- |
| `memoryLimitBytes`  | 64 MiB (`67108864`) | QuickJS guest heap allocation                                   |
| `maxStackSizeBytes` | 1 MiB (`1048576`)   | QuickJS stack guard                                             |
| `maxSourceBytes`    | 256 KiB (`262144`)  | Submitted function body, measured in UTF-8 bytes                |
| `maxOutputBytes`    | 256 KiB (`262144`)  | Final JSON return value or script-error message, in UTF-8 bytes |

Omitted fields use their defaults. Each value must be a positive integer.
Memory, source, and output limits allow up to 2147483647 bytes; the stack limit allows up to
4 MiB (`4194304`), leaving headroom below the pinned WASM build's 5 MiB stack.
Invalid values reject with `RangeError` before registry access or worker
startup, even when the caller signal is already aborted. Zero, negative values,
and infinity do not disable limits.

After validating options, pre-aborted cancellation wins. Otherwise oversized source
returns this report before reading tools, creating the worker, or parsing code:

```ts
await execute("return 42;", {}, { maxSourceBytes: 5 });
// {
//   result: {
//     ok: false,
//     error: {
//       kind: "limit", resource: "source", maximum: 5,
//       message: "Source exceeds the 5 byte limit."
//     }
//   },
//   calls: []
// }
```

The source limit counts the supplied body, including comments and whitespace,
but excludes the private wrapper/prelude. UTF-8 bytes differ from JavaScript
string length for non-ASCII text. Byte measurement does not allocate an encoded
copy of the source.

```text
resolve defaults -> validate options -> check pre-aborted cancellation
  -> measure source bytes -> reject oversized source with no calls
  -> snapshot tools -> start worker with resolved memory/stack limits
  -> worker validates startup data -> configure VM -> execute
```

VM memory and stack limits apply to each fresh execution. Guest allocation and
recursion errors retain ordinary JavaScript behavior: scripts can catch them;
uncaught errors become `script` results. Failures in VM/bridge/prelude setup or execution
machinery still reject with `SandboxExecutionError`. Error text is not used to
guess a structured memory/stack limit failure. Very small limits can prevent
sandbox setup from completing.

These settings do not cap total host/WASM memory or enlarge the WASM build's
physical stack. Source admission happens before the execution deadlines start;
guest parsing remains covered by `timeoutMs` and the optional parent deadline.

### Final output limit

`maxOutputBytes` bounds the guest's final return value and script-error message:

```ts
await execute('return "too much";', {}, { maxOutputBytes: 5 });
// {
//   result: {
//     ok: false,
//     error: {
//       kind: "limit", resource: "output", maximum: 5,
//       message: "Output exceeds the 5 byte limit."
//     }
//   },
//   calls: []
// }
```

Return values count their serialized JSON bytes, including quotes and escapes;
undefined returns normalize to `null` (four bytes). Script errors count the raw
message's UTF-8 bytes, including thrown strings, syntax errors, and conversion
errors. Exactly the configured size is accepted. Oversized output is rejected,
not truncated.

```text
guest serializes return value once -> drain started calls and guest jobs
  -> worker measures JSON text -> output limit, or parse and return value
guest throws -> convert public script-error message
  -> worker measures message -> output limit, or return script error
```

Size checks run in the worker before sending the result to the parent. JSON return
text is checked before parsing into host data. Controlled timeout, cancellation,
and limit diagnostics are not subject to this content limit; an output-limit
message can itself be longer than a very small configured maximum.

Completed tool responses remain available. Pending calls when an oversized script
error ends execution are interrupted with `reason: "output-limit"`, including
when worker cleanup later fails. Return values retain the existing drain-before-
completion behavior. Tool arguments, tool responses, and retained response bodies
are not capped by `maxOutputBytes`: a script can process a large dataset and return
a small summary. This is a final guest-output bound, not a bound on the full report.

Serialization, error conversion, and reading text from the VM can allocate before
measurement. The output limit does not bound those temporary allocations or total
host memory.

### Tool-call limits

Each execution defaults to **100 total calls** and **10 outstanding calls**.
Override either field independently:

```ts
await execute(code, tools);
await execute(code, tools, { maxToolCalls: 200, maxConcurrentToolCalls: 5 });
```

Both counts must be integers from 1 to 2147483647. Invalid counts reject with
`RangeError` before source admission, registry access, or worker startup, including
when cancellation is already requested. A total limit below the concurrency limit
is valid; there is no required relationship between them.

- Each admitted invocation consumes one total call, including tool failures,
  discovery, and unawaited calls. Awaiting the same promise twice counts once.
- Argument serialization failures before admission consume no call capacity.
- A concurrency slot remains occupied until the response is handled: through
  guest-promise settlement on the worker, and through serialization/transport on
  the parent. Completed success or failure responses release the slot.
- Exactly the configured number is allowed. The next admission attempt ends
  execution with a structured limit result. Calls are not queued or retried, and
  guest `try/catch` cannot bypass execution-level limits.
- Total capacity is checked before concurrency. If both are exhausted, the result
  identifies the total-call limit.

```ts
await execute(
  "await tools.read(); return await tools.read();",
  {
    read: () => ToolResult.success(42),
  },
  { maxToolCalls: 1 },
);
// {
//   result: {
//     ok: false,
//     error: {
//       kind: "limit", resource: "tool-calls", maximum: 1,
//       message: "Execution exceeded the 1 tool-call limit."
//     }
//   },
//   calls: [{ callId: 1, name: "read", status: "completed", result: { ok: true, json: "42" } }]
// }
```

Concurrency exhaustion uses `resource: "concurrent-tool-calls"`. Excess calls never
invoke a host callback and do not appear in the dispatched-call report. Completed
responses stay completed; pending dispatched calls become interrupted with
`reason: "call-limit"` or `"concurrency-limit"`. The parent requests cooperative
tool cancellation and awaits worker cleanup. A later cleanup failure retains the
selected interruption reason in `SandboxExecutionError.calls`.

```text
guest serializes arguments
  -> worker validates payload and reserves total/concurrent capacity
       denied -> record structured limit, interrupt guest execution
       admitted -> allocate deferred promise and post tool request
  -> parent validates request and independently reserves capacity
       denied -> select limit result and close dispatch/call snapshot
       admitted -> record dispatch, invoke tool, retain and post response
  -> parent releases slot; worker settles guest promise and releases its slot
```

Checking on the worker bounds deferred allocations and posted requests during a
synchronous guest burst. Checking on the parent independently bounds host dispatch.
The two budgets are local to their execution boundaries; reply transit can keep a
worker slot occupied after the parent has released its slot. Limits are per
execution, not application-wide. Tools that ignore cancellation may continue after
their execution has ended.

### Execution reports and retained calls

`execute` returns `Promise<ExecutionReport>`: `{ result: SandboxResult, calls }`.
Callers migrating from the earlier API read `report.result` for the execution outcome.
The worker-local engine still returns `GuestResult`; only the parent owns call records.

Each call record has an execution-local `callId`, tool `name`, and one of:

- `completed`: the parent recorded a serialized public response before selecting
  the execution outcome. `result` is `{ ok: true, json: string | undefined }` or
  `{ ok: false, error: { message: string } }`.
- `interrupted`: the parent started invocation but had not recorded its response
  when execution stopped. `reason` explains why observation ended:
  `cancelled`, `timeout`, `script-error`, `sandbox-error`, `call-limit`, `concurrency-limit`, or `output-limit`.
  The operation may still finish or have side effects.

`cancelled` means the caller requested cancellation; `timeout` means a guest or
total deadline expired; `script-error` means guest execution failed; `sandbox-error`
means the worker, transport, or execution machinery failed. Detailed sandbox
failure causes remain on `SandboxExecutionError` rather than in each call record.
`call-limit` and `concurrency-limit` identify execution stopped by tool admission.
`output-limit` identifies an oversized final guest result or script-error message.

Completed means an observed response, not guest receipt or proof of an external
transaction. Even a failed response, including the generic response for a thrown
callback, does not establish that no side effects occurred. Cancellation or
deadline expiry during result conversion leaves the call interrupted for that reason.

Records remain in invocation order, even when replies arrive out of order. Calls
rejected before invocation, including malformed requests, do not appear. Call
arguments and raw host objects are not retained. Success bodies are the same JSON
text prepared for the guest; retention never repeats `toJSON`. Undefined tool
results retain a present `json: undefined` field (ordinary JSON export omits it).

Call outcomes are exposed through `readonly` TypeScript types. The sandbox stops
updating the snapshot when the parent selects the execution outcome, before
notifying tool abort listeners or awaiting worker termination. Late settlements cannot change it and
are discarded before conversion. These records are in-memory observations, not a
durable audit log or a guarantee of safe retry.

For example, cancellation after invoice creation but during a second tool call:

```ts
const report = {
  result: {
    ok: false,
    error: { kind: "cancelled", message: "Execution cancelled." },
  },
  calls: [
    {
      callId: 1,
      name: "createInvoice",
      status: "completed",
      result: { ok: true, json: '{"id":"invoice-1"}' },
    },
    { callId: 2, name: "wait", status: "interrupted", reason: "cancelled" },
  ],
};
```

`bun run example` demonstrates this sequence using an explicit start gate.

Registry setup, worker construction, supervision, and cleanup failures reject with
host-only `SandboxExecutionError`. Its `calls` carries the same snapshot and its
`cause` preserves the original host-side failure. If execution and cleanup both
throw, the cause retains the disposal `SuppressedError` chain. Invalid budgets
continue to reject with `RangeError` before execution.

Once selected, interruption reasons do not change during cleanup. For example,
cancellation followed by a termination failure rejects with `SandboxExecutionError`,
but pending calls keep `reason: "cancelled"`. Completed responses remain completed.

```ts
import { execute, SandboxExecutionError } from "./src/sandbox";

try {
  const report = await execute("return 42;");
  console.log(report.result, report.calls);
} catch (error) {
  if (error instanceof SandboxExecutionError) {
    console.error(error.calls, error.cause); // Host-only diagnostics.
  }

  throw error;
}
```

### Cancellation

Pass a caller signal to cancel execution. Tools can pass their separate execution
signal to cancellable APIs such as `fetch`:

```ts
const controller = new AbortController();
const completion = execute(
  "return await tools.read();",
  {
    read: async (_args, { signal }) => {
      const response = await fetch("https://example.com/data", { signal });

      return ToolResult.success(await response.text());
    },
  },
  { signal: controller.signal },
);

controller.abort();
await completion;
// { result: { ok: false, error: { kind: "cancelled", message: "Execution cancelled." } }, calls: [] }
```

All calls in one execution share a tool signal. Cancellation, timeout, script
failure, and worker infrastructure failure request tool cancellation. Successful
guest completion leaves that signal un-aborted. Tools that subscribe manually
should remove their listeners when their work finishes.

Cancellation is cooperative: a tool can ignore the signal and may still complete
or have side effects. Execution waits for worker termination, not for cancelled
tools to settle. A cancelled result does not establish whether dispatched tools
completed, and does not mean retrying them is safe.

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
  worker-execution.ts: execute(...), deadlines/cancellation, and the worker supervisor
  execution-report.ts: call records, snapshots, and host infrastructure errors
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

Supporting modules: `execution-limits.ts` defines byte/count defaults and validation;
`tool-call-budget.ts` provides the total/outstanding counters owned independently by each boundary;
`runtime.ts` creates a VM with memory and stack limits;
`worker-protocol.ts` and `sandbox-result.ts` define shared data contracts;
`listener.ts` registers listeners whose removal is owned by a cleanup stack.

A tool call travels up and its reply travels back down:

```text
guest: tools.add(args) -> prelude serializes arguments to JSON text
worker: allocate call ID, post tool-call { callId, name, argsJson }
main: decode and parse arguments once, validate the call, record dispatch,
      invoke callback(args, { signal }), serialize the ToolResult,
      record completed response, post tool-result { callId, result }
worker: decode reply, match call ID, resolve or reject the guest promise
worker: pump QuickJS jobs -> prelude decodes the result -> guest resumes
```

Resolving a guest promise queues continuations; `runtime.executePendingJobs()`
runs them. The job pump processes at most 100 jobs per turn and yields to host
timers and I/O between batches.

Execution report flow:

```text
parent accepts completion / cancellation / timeout / infrastructure failure
  -> close dispatch and snapshot call outcomes
       recorded responses -> completed
       unresolved dispatched calls -> interrupted with the selected reason
  -> request interruption; abort tool signal on unsuccessful execution
  -> await worker cleanup
       success -> return { result, calls }
       infrastructure or cleanup failure -> reject SandboxExecutionError(calls, cause)
```

### Ownership

| Owner                        | Resources                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| Main-thread supervisor       | Worker, listeners, parent timer/interrupt flag, tool abort controller, call records |
| Worker entry's cleanup stack | Transport listeners and pending remote replies                                      |
| Engine                       | QuickJS context and runtime, deadline, and bridge scope                             |
| Guest bridge                 | Borrows the context and scope; deferred handles belong to that scope                |
| Main app's catalog           | Callback bindings and metadata; no VM or worker resources                           |

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
  `failure` records the first private infrastructure failure or admission limit and `failureSignal`
  wakes the engine. The worker bridge's `pendingReplies` correlates call IDs with
  main-thread replies.

## Contracts

### Results and failures

- Script errors, timeouts, and caller cancellation resolve in `report.result` with
  kind `script`, `timeout`, or `cancelled`. Thrown strings become the message;
  other values without a string `message` produce a generic message. Thrown
  promises are opaque values, not awaited or unwrapped.
- Oversized source resolves with `kind: "limit"`, `resource: "source"`, the byte
  maximum, and no calls. Source admission belongs to the parent; workers cannot
  report a source-limit result or caller cancellation.
- Tool admission exhaustion resolves with `kind: "limit"` and resource
  `tool-calls` or `concurrent-tool-calls`. The worker and parent each enforce these
  limits; they are distinct from catchable tool failures and sandbox errors.
- Oversized guest output resolves with `kind: "limit"`, `resource: "output"` and
  its byte maximum. The worker enforces this before transferring its result.
- `ToolResult.failure(message)` is the only way a host message reaches the guest.
  Exceptions thrown by a callback become `Host tool failed.` without exposing
  private messages or stacks. Scripts can catch tool rejections and continue.
- Infrastructure failures reject the host promise and never become catchable tool
  failures: parser and VM allocation/settlement failures, protocol violations,
  transport failures, worker crashes, and premature exit. They are not retried
  against the VM.
- Within the worker, infrastructure failures keep their original cause. Across the
  worker boundary, the worker sends only a controlled failure category and the
  supervisor uses a new controlled error as `SandboxExecutionError.cause`; worker
  exception messages, stacks, and identity are not transferred. Local registry,
  construction, transport, and termination failures retain their identity in the
  host-only cause instead of being forwarded to the guest.
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
and worker construction. Every execution has a parent-owned one-word shared interrupt
flag; the total budget adds a parent timer. The flag is supplied only to trusted worker
code; it is never exposed to the guest.

```text
validate options -> admit source -> record parent deadline -> construct worker -> supervise
  -> on messages and callback settlements: check the clock before continuing
  -> on expiry: select total-timeout result, close dispatch/call snapshot, set shared flag
  -> clear parent timer, remove normal listeners, request worker termination
  -> await termination, remove error listener, return report (or reject cleanup failure with calls)
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

### Cancellation and cleanup ordering

```text
validate options -> if already aborted: return cancelled report with no calls
  -> admit source -> snapshot registry -> recheck cancellation -> create worker and supervise
  -> caller abort: check total deadline, choose timeout or cancelled outcome
  -> close dispatch and call snapshot -> set shared interrupt flag -> abort host-tool signal
  -> remove caller/worker listeners and timer -> terminate worker
  -> await termination -> remove worker error listener -> return report
```

- Invalid budgets or byte limits reject even when the caller signal is already aborted. A
  pre-aborted execution skips registry access and worker creation.
- The first accepted outcome wins. If the total deadline has already elapsed when
  cancellation is observed, the result is `timeout`; otherwise it is `cancelled`.
  Later cancellation cannot replace a completed result or infrastructure failure.
- Tool abort listeners run synchronously, so the supervisor closes dispatch and
  selects its outcome before notifying them. Reentrant calls and late results are
  discarded. A guest cannot catch caller cancellation and keep the execution alive.
- Caller reasons are never inspected, serialized, or passed to tools. Tools receive
  a generic `AbortError`; the worker receives only the shared interrupt flag.
- Cleanup removes the caller's abort listener on success, cancellation, and failure,
  including partial registration. Termination failure still rejects the host promise.
- A synchronous main-thread callback, conversion, or tool abort listener can delay
  cancellation and cleanup. There is no hard cancellation-latency guarantee.

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
- Configurable limits cover guest heap (default 64 MiB), stack (default 1 MiB),
  submitted source and final guest output (each default 256 KiB), and deadlines,
  not total host/WASM memory or the full execution report's size.
- There is no worker pool: each execution pays worker startup and QuickJS loading.
- Worker startup is covered only when `totalTimeoutMs` is supplied. Without it,
  a stuck worker that neither reports nor exits can leave execution pending.
  The caller can cancel with `AbortSignal`, but there is no hard response-latency
  guarantee; shutdown still depends on Bun's termination behavior.
- Synchronous host callbacks and result conversion run on the main thread and cannot
  be interrupted. The guest deadline checks source parsing after it returns;
  the parent can request worker termination meanwhile.
- Timeout, failure, or cancellation ends sandbox execution and requests cooperative
  tool cancellation. Started operations may still finish or have side effects;
  there is no rollback, automatic retry, or exactly-once guarantee. Retained call
  outcomes describe only parent observations at execution completion; unresolved
  dispatched calls are marked interrupted with the reason observation ended.
  Call counts and outstanding calls are bounded per execution; payload size and
  retained bytes are not yet bounded.
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

Tests are grouped by the boundary they verify:

- `tests/unit/`: protocol decoding, catalog logic, and rejection helpers.
- `tests/component/`: real QuickJS/bridge ownership, worker supervision, and fault injection.
- `tests/integration/`: public `execute` behavior, discovery, deadlines, cancellation,
  and subprocess lifecycle.
- `tests/support/`: shared mechanics; `tests/fixtures/`: executable worker/process scenarios.

`executeEngine` accepts `installToolBridge`. Production supplies
`installWorkerToolBridge`; engine tests use `installLocalToolBridge` from
`tests/support/local-tools.ts`. Both use the real `installGuestToolBridge`.
The local adapter keeps VM handles and original exceptions observable.

See [Testing conventions](tests/README.md) for placement, readability, and async
ordering rules. `bun run test` runs every layer; `bun test ./tests/component` runs
one layer. Typechecking includes all test helpers and fixtures.

## Milestones

1. Synchronous QuickJS execution.
2. Async host-call bridge with explicit `ToolResult`.
3. Private guest prelude and wrapper validation.
4. Worker-backed execution.
5. Worker-backed host tools, host-owned catalog, and discovery.
6. Configurable guest deadlines and opt-in parent-supervised deadlines/interruption.
7. Caller cancellation and cooperative host-tool cancellation.
8. Parent-owned execution reports with completed responses and explicit call interruption reasons.
9. Optional memory, stack, and UTF-8 source limits with defaults and pre-startup admission.
10. Per-execution tool-call and concurrency limits enforced before deferred allocation and host dispatch.
11. Optional final guest-output limit covering UTF-8 JSON returns and script-error messages.

Next:

1. One synthetic MCP upstream to the host catalog, exercising realistic tool payloads.
2. Schema-backed argument validation; revisit payload/retention bounds using integration evidence.
3. Soak/fault testing, latency/memory measurements, and reference comparisons.

Do not add a gateway framework before the sandbox behavior is understood.
