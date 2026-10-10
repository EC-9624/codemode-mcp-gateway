# MCM

A small code-mode sandbox built for learning. We implement execution and the
host-call bridge ourselves, using QuickJS as the JavaScript engine. Pi and
Executor are source references, not runtime dependencies.

## Run

Requires Bun 1.4.2.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run example
bun run check
```

## Milestone 1: synchronous execution

```ts
import { execute } from "./src/sandbox";

await execute("return 1 + 2;");
// { ok: true, value: 3 }

await execute('throw new Error("Something failed");');
// { ok: false, error: { kind: "script", message: "Something failed" } }
```

Input is the body of a synchronous function, not an expression or a module.
Ordinary JavaScript runs inside QuickJS; `process`, `Bun`, `require`, and `fetch`
are not exposed. Each call creates a fresh runtime and context. Only the
compiled WASM module is shared.

### Execution and ownership

1. Load the cached QuickJS WASM module.
2. Create a runtime with a 64 MiB guest heap limit, a 1 MiB stack limit, and a
   one-second monotonic computation deadline.
3. Create a context and evaluate the script inside a function wrapper.
4. Convert the result to JSON inside the VM, then decode it on the host.
5. Dispose the result/error handle, context, and runtime, in that order, using
   `using` declarations.

QuickJS handles point into WASM memory and require explicit disposal; ordinary
host garbage collection is not sufficient. Successful and failed executions
both release their resources.

`using` calls each resource's `Symbol.dispose` method when its scope exits, even
on an early return or exception. Resources are disposed in reverse declaration
order, keeping the execution flow flat without nested cleanup blocks.

JSON conversion uses native semantics: undefined object properties are omitted;
undefined array entries and non-finite numbers become null. An absent or
undefined top-level return becomes null. BigInt, circular values, and unsupported
top-level values produce script errors. Getters and `toJSON` run inside the VM.
Promise/thenable returns are rejected: there is no async bridge or job pump yet.

### Current limitations

- Execution is synchronous on the host thread after WASM loading. An infinite
  loop is interrupted, but blocks the host until the interrupt runs. This is not
  worker isolation or a hard response-latency guarantee.
- Limits cover guest execution, not total host/WASM memory or model-facing output.
- No injected tools, cancellation signal, imports, TypeScript, or persistent state.
- VM/loading infrastructure failures can reject the host promise; script failures
  return the explicit error result.
- This is a learning milestone, not a production-hardened sandbox.

## Next milestones

1. Inject one async host function, bridge promises, and advance QuickJS jobs.
2. Move execution into a worker; add cancellation and reliable worker cleanup.
3. Add tool discovery, boundary validation, and one MCP upstream.

Do not add a gateway framework before the sandbox behavior is understood.
