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
compiled WASM module is shared.

### Two promise environments

```text
guest tools.add(args)
  -> guest wrapper serializes arguments to JSON text
  -> host decodes arguments, awaits the callback, and unwraps its explicit result
  -> host resolves a QuickJS promise with JSON text (or rejects it)
  -> advance QuickJS jobs
  -> guest wrapper decodes the result and the script resumes
```

The host callback returns a guest promise handle, not a Bun promise. The bridge
connects the two using `context.newPromise()`. Resolving that promise queues guest
continuations; `runtime.executePendingJobs()` runs them. The job pump processes
at most 100 jobs per turn and yields to host timers/I/O between batches.

Native JSON functions are captured by the guest wrappers before user code runs.
The host bridge handles only JSON strings or undefined, not guest object graphs.
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
- `src/sandbox.ts`: orchestrates execution, wraps code, pumps jobs, and enforces
  the per-execution deadline.
- `src/tool-bridge.ts`: installs host callbacks and settles guest promises through
  JSON text.

The public `execute()` flow is deliberately small:

```ts
using vm = await createVm();
using bridgeScope = new Scope();
const bridge = installTools(vm, tools, bridgeScope);
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
- Unexpected parser errors and VM allocation/settlement failures reject the host
  promise with their original cause. They are not reclassified as tool failures
  or retried against the VM. The job pump checks bridge failures between turns,
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
  A host timer wakes idle execution; the QuickJS
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

- Source parsing, VM computation, and synchronous parts of host callbacks still
  run on the host thread. An infinite guest loop is interrupted, but blocks the host until the
  interrupt runs. A synchronous host callback cannot be forcibly interrupted.
  Host-side source parsing is checked against the deadline after it returns,
  not interrupted while it runs.
  This is not worker isolation or a hard response-latency guarantee.
- Limits cover guest execution, not total host/WASM memory or model-facing output.
- Timeout or failure stops waiting and closes the VM, not the host operation.
  Started operations may still finish or have side effects; there is no rollback,
  automatic retry, cancellation signal, or exactly-once guarantee.
- No imports, TypeScript, persistent state, discovery, or MCP integration yet.
- Parser/VM/loading infrastructure failures can reject the host promise; script
  failures return the explicit error result.
- This is a learning milestone, not a production-hardened sandbox.

## Next milestones

1. Move execution into a worker; add cancellation and reliable worker cleanup.
2. Add tool discovery, schema validation, and one MCP upstream.

Do not add a gateway framework before the sandbox behavior is understood.
