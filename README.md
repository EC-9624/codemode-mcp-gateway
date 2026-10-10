# MCM

A code-mode sandbox developed in small, explainable slices toward production
readiness. We implement execution and the host-call bridge ourselves, using
QuickJS as the JavaScript engine. Pi and Executor are source references, not
runtime dependencies. Learning shapes the delivery, not the final scope.

## Run

Requires Bun 1.4.2. Bun is the only supported host runtime for now.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run example
bun run check
```

## Code style and checks

Code explains **How**, tests specify **What**, commit logs explain **Why**, and
code comments explain **Why not**. Comments preserve non-obvious constraints;
tests prove the behavior they name, including resource ownership where claimed.

`AGENTS.md` defines the project-specific style and ownership rules. Oxfmt uses
`.oxfmtrc.json` to preserve the existing formatting. Oxlint uses `.oxlintrc.json`
with native rules and `oxlint-tsgolint` for type-aware promise and unsafe-operation
checks. Bare `void` does not exempt an unhandled promise from linting.

Lint also enforces named rather than namespace imports, type-only import markers,
`const` where possible, and guard clauses where an `else` follows a return.
Import aliases, helper extraction, narrow catches, and VM resource ownership remain
review rules; the configuration does not claim to enforce them automatically.
Legitimate `unknown` boundaries and runtime validation remain supported. No
anti-slop preset is installed.

```sh
bun run format
bun run lint
bun run typecheck
```

## Milestone 1: synchronous execution

```ts
import { execute } from "./src/sandbox";

await execute("return 1 + 2;");
// { ok: true, value: 3 }

await execute('throw new Error("Something failed");');
// { ok: false, error: { kind: "script", message: "Something failed" } }
```

## Milestone 2: async host-call bridge

```ts
import { execute, ToolResult } from "./src/sandbox";

await execute("return await tools.answer();", {
  answer: async () => {
    await Bun.sleep(10);
    return ToolResult.success(42);
  },
});
// { ok: true, value: 42 }
```

`examples/basic.ts` also implements `tools.add({ a: 1, b: 2 })` with host-side
argument validation. Callbacks receive `unknown` and must validate their domain
inputs. They return `ToolResult.success(value)` or
`ToolResult.failure(publicMessage)` rather than throwing validation errors.
This replaces the previous raw-return/`ToolError` API. The bridge unwraps the
result; guests still receive ordinary values or catchable promise rejections.
Failure-shaped JSON data remains ordinary data when wrapped in `success`.
Only explicitly supplied tools are exposed, on a frozen, null-prototype guest
object.

Input is now the body of an async function, not an expression or a module.
Ordinary JavaScript runs inside QuickJS; `process`, `Bun`, `require`, and `fetch`
are not exposed. Each call creates a fresh runtime and context. Only the
compiled WASM module is shared within a host thread.

### Guest promise bridge

The guest bridge connects worker-side Bun promises to QuickJS promises. A message
bridge connects those worker promises to host callbacks on the main thread.

```text
guest tools.add(args)
  -> guest wrapper serializes arguments to JSON text
  -> worker sends a tool-call message to the main thread
  -> main thread decodes arguments, awaits the callback, and serializes its result
  -> worker receives the reply and resolves or rejects the QuickJS promise
  -> worker advances QuickJS jobs
  -> guest wrapper decodes the result and the script resumes
```

The callback installed inside QuickJS returns a guest promise handle. The actual
host tool callback returns `ToolResult` or a Bun promise of it on the main thread.
The worker bridge uses `context.newPromise()` to connect the reply to the guest.
Resolving that promise queues guest
continuations; `runtime.executePendingJobs()` runs them. The job pump processes
at most 100 jobs per turn and yields to host timers/I/O between batches.

Native JSON functions are captured by the guest wrappers before user code runs.
The worker's guest bridge handles only JSON strings or undefined, not guest object graphs.
It no longer needs guest JSON function handles or calls back into the VM to
serialize arguments or parse results. Malformed low-level payloads fail before
host dispatch. A synchronous argument conversion failure still throws at the
call site; the result decoder uses native async/await rather than a mutable
guest `Promise.prototype.then`.

## Milestone 3: private guest prelude

Trusted setup and submitted code are compiled separately inside QuickJS:

```text
validate the complete async function wrapper with Acorn
  -> evaluate the trusted prelude factory
  -> factory captures raw callbacks and publishes only wrapped tools
  -> compile the validated user function in the VM's global scope
  -> private runner calls that function with tools and serializes its result
```

The user function cannot see `hostTools`, captured JSON functions, or the private
runner through lexical scope, `eval`, or dynamic function constructors. Public
`tools` remain available as the function parameter and through `globalThis.tools`.
Raw callbacks are not left on a public global.

Acorn checks that the entire source is exactly the intended async arrow function,
with its body boundaries intact. It does not interpret the AST, rewrite the
program, or impose a JavaScript subset. This check is necessary because even
QuickJS's native async-function constructor accepted a tested wrapper-escape
payload and dispatched a tool while constructing the function. Malformed bodies
now fail before any user code or host call executes.

Guest built-ins remain mutable; the prelude captures the JSON functions it uses.
VM-local `eval`/`Function`, normal closures, classes, generators, native JSON
hooks, and the existing guest-global `this` binding remain supported. This slice
is a boundary fix, not worker isolation or blanket built-in lockdown.

### Module boundaries

- `src/runtime.ts`: loads QuickJS and creates a fresh VM with memory/stack limits.
- `src/sandbox.ts`: public worker-backed `execute(code, tools)` and type exports.
- `src/sandbox-engine.ts`: wraps code, pumps jobs, and enforces the worker-local
  per-execution deadline.
- `src/tool.ts`: host callback contracts, private-error handling, and JSON conversion.
- `src/tool-catalog.ts`: host-owned tool descriptions, schemas, callback bindings,
  and discovery callbacks.
- `src/guest-tool-bridge.ts`: installs guest callbacks and settles guest promises through
  JSON text. The same-thread adapter lives in `tests/local-tools.ts` for engine-level
  ownership and fault tests.
- `src/worker-tool-bridge.ts`: connects the guest bridge to main-thread messages,
  correlates calls with replies, and registers transport cleanup.

### Execution boundaries and ownership

**Guest** means JavaScript inside QuickJS. **Worker** means the Bun thread embedding
QuickJS. **Main app** means the main thread holding tool implementations and the
catalog. The worker is QuickJS's immediate host, so "host" alone can be ambiguous.

```text
Main app
  sandbox.ts -> worker-execution.ts
  tool-catalog.ts: metadata and discovery
  tool.ts: actual callback invocation and result serialization
       |
       | worker messages: call IDs, names, JSON payloads
       v
Worker thread (Bun)
  worker-entry.ts: assemble the engine and tool connection
  worker-tool-bridge.ts: connectGuestToolsToMainThread(...)
       |
  sandbox-engine.ts: own VM, compile source, pump jobs, enforce deadline
  guest-tool-bridge.ts: installGuestToolBridge(...)
       |
       | VM boundary: QuickJS handles and deferred promises
       v
QuickJS guest
  private prelude: JSON conversion and public tools.<name> wrappers
  submitted code: await tools.someTool(args)
```

Calls travel upward in this diagram; replies travel back down. Both bridge modules
run as Bun code in the worker, outside QuickJS. The worker bridge installs the
guest bridge as well as wiring the message port; it is not a standalone transport client.

| Owner                        | Resources                                                            |
| ---------------------------- | -------------------------------------------------------------------- |
| Main-thread coordinator      | Worker lifecycle and callback dispatch                               |
| Worker entry's cleanup stack | Transport listeners and pending remote requests                      |
| Engine                       | QuickJS context/runtime, deadline, and bridge scope                  |
| Guest bridge                 | Borrows the context and scope; deferred handles belong to that scope |
| Main app's catalog           | Callback bindings and metadata; no VM or worker resources            |

`worker-protocol.ts` and `sandbox-result.ts` define shared data contracts. The
entry point determines the thread where a module runs; directory placement does
not. Engine-level tests use `tests/local-tools.ts` to exercise the same guest bridge
on the test thread. Source files stay in a flat `src/` directory.

The worker-local engine's flow is deliberately small:

```ts
using vm = await createVm();
using bridgeScope = new Scope();
const bridge = installBridge(vm, bridgeScope);
return await executeScript(vm, code, bridge);
```

These are separate responsibilities, not separate runtime frameworks. The VM is
the SDK's context, which owns its runtime.

### Errors and completion

- Return `ToolResult.failure(message)` for an intentionally public
  validation/domain failure. Exceptions thrown by the host callback become
  `Host tool failed.` without exposing private messages or stacks. Scripts can
  catch tool rejections and continue.
- Catches surround only throwing dependency boundaries: Acorn syntax errors and
  JSON conversion failures become explicit results. Getters and `toJSON` may
  throw arbitrary values during host result conversion; these remain private
  and produce the public conversion error.
- Unexpected parser errors and VM allocation/settlement failures propagate with
  their original cause within the engine thread. Public `execute` rejects with a
  controlled worker-failure message, without transferring private details. They are not
  reclassified as tool failures or retried against the VM. The job pump checks bridge failures between turns,
  including while guest jobs keep arriving.
- An uncaught script rejection ends execution. Late host completions do not
  access the closed VM.
- Thrown promises are opaque values without an error message, not promises to
  await or unwrap. Error reporting borrows the thrown handle and disposes only
  the owned promise-state handles; the SDK's `dump` consumes promise handles.
- Successful scripts wait for all started host calls and queued guest jobs,
  including calls started by `toJSON`, before returning. Awaiting the same
  promise twice does not dispatch twice; `Promise.race` does not cancel losers.
- Draining calls is not proof that they all succeeded: tool rejections follow
  native promise semantics. Scripts must await/catch failures; this slice does
  not audit unhandled rejections.
- A pending guest promise with no queued jobs or pending host calls cannot make
  progress and fails explicitly instead of hanging.
- One monotonic deadline covers source validation, prelude setup, execution,
  guest jobs, and host waits after WASM loading, VM setup, and tool installation.
  A worker timer wakes idle execution; the QuickJS
  interrupt handler stops running guest computation.

### Execution and ownership

1. Load the cached QuickJS WASM module.
2. Create a context with its own runtime, a 64 MiB guest heap limit, and a
   1 MiB stack limit. The SDK disposes the runtime with its context.
3. Install tool callbacks whose deferred promises belong to the bridge scope.
4. Start the one-second deadline, validate the source wrapper, and compile the
   prelude and user function separately. Call the private runner and pump guest
   jobs alongside host calls.
5. Convert the final result to JSON inside the VM, then decode it on the host.
6. Dispose the result and deadline timer, then bridge handles and the VM (context
   and owned runtime), using `using` declarations.

QuickJS handles point into WASM memory and require explicit disposal; ordinary
host garbage collection is not sufficient. Successful and failed executions
both release their resources.

`using` calls each resource's `Symbol.dispose` method when its scope exits, even
on an early return or exception. Resources are disposed in reverse declaration
order, keeping the execution flow flat without nested cleanup blocks.

The VM factory transfers ownership only after setup succeeds. Its single
`try/catch` releases the context if configuration fails; a factory-local `using`
would incorrectly dispose the VM before its caller could use it.

Promise resolvers outlive an individual tool callback, so a QuickJS `Scope`
owns them for the execution. The bridge checks that this scope is still alive
before touching the VM after a host operation settles.

JSON conversion uses native semantics: undefined object properties are omitted;
undefined array entries and non-finite numbers become null. An absent or
undefined top-level return becomes null. BigInt, circular values, and unsupported
top-level values produce script errors. Getters and `toJSON` run inside the VM.
Promise/thenable returns are awaited using native guest semantics. Arguments and
tool results also cross through JSON, so objects and executable methods are not
shared between host and guest. Unsupported tool arguments fail before dispatch;
unsupported tool results reject with a public conversion error.

### Current limitations

- Source parsing and VM computation run in a fresh worker. Synchronous host
  callbacks and host result conversion still run on the main thread and cannot be
  forcibly interrupted. Source parsing is checked against the worker's deadline
  after it returns, not interrupted while it runs. There is no hard response-latency
  guarantee or parent-supervised startup deadline yet.
- Limits cover guest execution, not total host/WASM memory or model-facing output.
- Timeout or failure stops waiting and closes the VM, not the host operation.
  Started operations may still finish or have side effects; there is no rollback,
  automatic retry, cancellation signal, or exactly-once guarantee.
- No imports, TypeScript, persistent state, or MCP integration yet.
- Parser/VM/loading infrastructure failures can reject the host promise; script
  failures return the explicit error result.
- This is a learning milestone, not a production-hardened sandbox.

## Milestone 4: experimental worker execution

```ts
import { runSandbox } from "./src/worker-execution";

await runSandbox("return { answer: 42 };");
// { ok: true, value: { answer: 42 } }
```

`runSandbox(code)` runs source parsing and QuickJS computation in a fresh
Bun worker through `node:worker_threads`, keeping the main thread responsive during
busy guest computation. Bun remains the only supported host runtime.
This milestone originally reused the engine with an empty tool registry. Since
milestone 5, public `execute(code, tools)` uses this same coordinator with host tools.
The coordinator is named `runSandbox`; there is only one worker-backed execution
implementation.

```text
main thread: execute(code, tools) -> runSandbox(code, tools)
  -> create one referenced worker with the request in workerData
  -> install response/error/exit listeners
worker: decode workerData into a typed execution request
  -> executeEngine(code, installBridge): create VM, parse, run jobs, convert result, dispose VM
  -> post completion or a generic infrastructure failure
main thread: decode response, clean up listeners, await termination
  -> return SandboxResult or reject for infrastructure/transport failure
```

### Boundaries and ownership

- `src/worker-execution.ts` coordinates one execution and owns its worker and
  listeners through a scoped `AsyncDisposableStack`. Message and exit listeners
  are removed before termination; the error listener stays until termination settles
  so late errors cannot become unhandled EventEmitter errors. Partial setup also
  unwinds. Its internal `executeWorker`
  operation also enables real-worker lifecycle and failure tests without replacing
  host globals.
- `src/worker-entry.ts` statically imports the engine, decodes the initial
  `workerData`, installs the remote tool bridge, and owns sandbox execution inside
  the worker. Startup requires no
  request message, submission promise, or listener-before-import workaround.
- `src/worker-protocol.ts` defines request and response decoders that accept raw
  `unknown` values and return explicit success/failure unions. Execution logic uses
  decoded domain types; arbitrary guest results still remain `unknown`.
  Worker messages use structured cloning; guest values retain the engine's JSON
  semantics. No VM handles or tool functions cross the thread boundary.
- Guest errors and the existing one-second guest deadline retain their result
  contract. Worker startup, protocol, execution-infrastructure, deserialization,
  and premature-close failures reject the host promise instead of becoming script
  errors. The worker sends only a controlled failure category, which the coordinator
  turns into a new host error. Arbitrary worker exception messages/stacks are not
  sent to the caller; original error identity and cause are not preserved across
  this boundary. Exceptions raised locally by worker construction (including initial
  data serialization) propagate directly. These host-promise failures are separate from
  deliberately public, guest-visible tool rejections.
- Normal worker execution disposes its VM before posting completion. The
  coordinator awaits worker termination on both success and failure. The first
  execution outcome wins; duplicate/late events do not resettle it. A termination
  failure still rejects the host promise; cleanup failures are not swallowed.
  Bun's `node:worker_threads` termination promise is backed by its underlying
  worker `close` event, which marks termination rather than proving the thread has
  fully exited. Awaiting that promise is not a hard-stop guarantee. The tests also
  verify process exit after successful and failed guest executions.

### Deliberate limitations

There is no worker pool: each execution pays worker startup and worker-local
QuickJS loading costs. This is thread separation, not an OS/process sandbox or a
total host-memory limit. The trusted worker has Bun privileges; guest code still
executes only inside QuickJS.

The deadline still starts inside the existing engine after VM/tool setup. Worker
startup and loading are not covered. There is no parent watchdog, caller
`AbortSignal`, or hard response-latency guarantee yet; a stuck worker that neither
reports failure nor closes can leave execution pending. Cross-thread host tools
are implemented below; supervised cancellation is the next slice.

## Milestone 5: worker-backed host tools

The public API is unchanged:

```ts
import { execute, ToolResult } from "./src/sandbox";

await execute("return await tools.answer();", {
  answer: async () => ToolResult.success(42),
});
// { ok: true, value: 42 }
```

`execute` snapshots the supplied registry, retains callbacks on the main thread,
and passes source plus tool names to a fresh worker. The worker imports the engine,
never the public wrapper. No callback functions or QuickJS handles cross threads.

```text
main: execute(code, tools) -> coordinator -> workerData { code, toolNames }
worker: executeEngine -> connectGuestToolsToMainThread -> installGuestToolBridge -> QuickJS guest

guest: await tools.answer(args)
  -> private wrapper serializes arguments
worker: allocate call ID, send tool-call { callId, name, argsJson }
main: validate call, invoke callback, serialize explicit ToolResult
  -> send tool-result { callId, result }
worker: decode reply, match call ID, resolve/reject the guest promise
  -> pump QuickJS jobs; guest resumes

worker: dispose VM, close remote bridge, send final result
main: close dispatch, await worker termination, return SandboxResult
```

### Protocol and ownership

- Startup data and both message directions have typed decoders. JSON strings are
  validated before dispatch or guest settlement. Tool callbacks still validate
  their own domain inputs; arbitrary input/output data remains `unknown`.
- Per-execution call IDs increase in dispatch order. The host rejects unknown
  tool names and invalid/replayed call IDs. Replies may finish out of order;
  the worker rejects unknown/duplicate replies while execution is active.
- Callback values undergo native JSON conversion on the host before transport,
  preserving getters, `toJSON`, conversion errors, and `undefined` tool results.
  Structured cloning transports only envelopes and serialized data.
- The worker owns its pending remote resolvers and listeners. The engine scope
  owns QuickJS handles. Protocol/transport failures wake the engine through the
  bridge's separate infrastructure-failure signal, including during idle waits
  and continuous guest jobs. They never become catchable tool failures.
- Host dispatch observes every started callback. On completion/failure it stops
  dispatching and drops late results before conversion or posting. Pending host
  operations are not awaited during cleanup, cancelled, retried, or rolled back.

### Preserved behavior and verification

Guests still receive ordinary values or catchable tool rejections. Explicit
failure messages are public; unexpected callback exceptions become `Host tool
failed.`. Script failures and engine timeouts return `SandboxResult`; worker and
transport infrastructure failures reject the host promise. Local transport
exceptions retain their identity; worker-local exceptions do not cross threads.

Successful execution drains started calls, including unawaited calls, race losers,
and calls started by guest result serialization. Failure/timeout closes execution
without waiting for unrelated callbacks. Awaiting one promise twice never replays
its call. Concurrent executions have separate registries and call IDs.

The behavior tests use public worker-backed `execute`. Engine-local fault tests
still cover original exception identity and VM ownership. Additional tests cover
out-of-order replies, JSON conversion on the host, malformed/duplicate messages,
transport failure, worker crashes during calls, and late callback completion.

This slice does not move callback CPU work off the main thread or add parent
deadlines, caller cancellation, worker pooling, or MCP integration.

### Host-owned catalog and discovery

The app owns tool metadata and implementations. `ToolCatalog.create` captures
callback bindings, names, and descriptions from a definition record. Input schemas
are descriptive metadata, not automatic validators; callbacks still validate their
domain inputs. Schema objects remain host-owned and should be treated as read-only.

```ts
import { execute, ToolResult } from "./src/sandbox";
import { createDiscoveryTools, ToolCatalog } from "./src/tool-catalog";

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
- Discovery callbacks use the existing tool-call bridge. Guests call them through
  `tools`, just like any other tool. Invalid requests and missing description names
  produce deliberately public tool failures.
- The app selects the catalog and exposed callbacks for an execution. Discovery
  names are chosen explicitly, so an app can expose `findTools: discovery.searchTools`
  when its catalog already contains a tool named `searchTools`.
- Guest wrappers already exist for the supplied callbacks; discovery does not install
  additional tools. Names are preserved exactly: use `tools["billing.listInvoices"]`
  for names that are not JavaScript identifiers.

Only callable names go to the worker at startup. Metadata reaches the guest when
discovery returns it. Future MCP connections belong to the app; an MCP adapter can
provide definitions and callbacks without teaching the engine about MCP.

Production has one worker-backed execution path. Same-thread callback wiring is
test support and reuses the real guest bridge and host callback/serialization logic.

## Next milestones

1. Add parent-supervised deadlines, caller cancellation, and worker cleanup supervision.
2. Add schema-backed argument validation and one MCP upstream to the host catalog.

Do not add a gateway framework before the sandbox behavior is understood.
