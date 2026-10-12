# codemode-mcp-gateway

A Bun stdio gateway that lets coding agents discover and compose one upstream
MCP server's tools through JavaScript. This product package provides both a
programmatic API and the `cmg` executable, composing `@cmg/codemode` and `@cmg/mcp`.
The package remains private while its API matures.

## Run from the repository

```sh
bun install --frozen-lockfile --ignore-scripts
bun run cmg examples/cmg.json
bun run example:server
```

Requires Bun **1.4.2**. `cmg` speaks MCP on stdin/stdout, so it waits for a client;
it is not a JavaScript REPL. `example:server` starts a client and the gateway,
discovers the synthetic upstream's tools, and executes a call end to end.
Stdout is exclusively MCP traffic; diagnostics and upstream stderr use stderr.

## Agent workflow

The agent sees only `execute({ code })`. Submit this async function body to search:

```js
return await tools.searchTools({ query: "add numbers" });
```

Search returns exact names, descriptions, and input schemas. Inspect one with
`tools.describeTool({ name: "add" })`, then call it and return the value you need:

```js
const response = await tools.add({ a: 2, b: 3 });
if (response.isError) return response.content;
return response.structuredContent.sum;
```

For the included upstream, the response contains:

```json
{
  "result": { "ok": true, "value": 5 },
  "calls": [{ "callId": 1, "name": "add", "status": "completed" }]
}
```

Tool names are preserved exactly; use `tools["billing.listInvoices"]` for names
that are not JavaScript identifiers. Local discovery calls share the execution budget.

## Results and failures

The response is emitted as structured content and JSON text. It includes compact
call summaries, not retained tool bodies. Upstream `isError` is data the script
must inspect; outer MCP `isError` indicates that the final execution failed.

Script errors, deadlines, cancellation, and execution limits appear in `result`.
Infrastructure failures use a controlled `sandbox` error; private diagnostics stay
host-side. Cancellation cannot roll back upstream side effects, and a completed
summary does not establish safe retry. See [execution contracts](../../docs/reference.md#execution-reports-and-retained-calls).

## Configuration

Stdio upstream:

```json
{ "upstream": { "transport": "stdio", "command": "bun", "args": ["upstream.ts"] } }
```

`cwd` defaults to the configuration file's directory; a supplied relative `cwd`
resolves from there. `args` pass unchanged. Optional `env` augments SDK defaults.
Command-only configurations without `transport` still select stdio.

HTTP upstream:

```json
{
  "upstream": {
    "transport": "http",
    "url": "https://example.com/mcp",
    "headers": { "Authorization": "Bearer {env:CMG_UPSTREAM_TOKEN}" }
  }
}
```

Header templates expand host environment variables before connecting. Missing
variables fail startup. The app does not perform OAuth login or store credentials.
Optional `sandbox` settings configure the fixed QuickJS policy; app defaults use
a 5-second guest deadline and 10-second total deadline. Other defaults come from codemode.

For example, cap total tool calls without allowing request overrides:

```json
{
  "upstream": { "command": "bun", "args": ["upstream.ts"] },
  "sandbox": { "maxToolCalls": 20 }
}
```

Limits must be positive integers within [codemode's bounds](../codemode/README.md#limits-and-boundaries).
Startup has separate budgets: 5 seconds for the upstream handshake and 15 seconds
for discovery. Configuration and the catalog do not reload during a run.

## Programmatic API

```ts
import { ToolCatalog, ToolResult } from "@cmg/codemode";
import { createServer } from "codemode-mcp-gateway";

const catalog = ToolCatalog.create({
  answer: { description: "Return the answer", execute: () => ToolResult.success(42) },
});
const server = createServer(catalog, { timeoutMs: 5_000 });
// Connect an application-owned transport and serve requests here, then close the server.
await server.close();
```

`createServer` composes a catalog and fixed sandbox policy without loading files
or installing process listeners. The caller owns the transport and any external
connections used by its catalog.

The public entry also exports `Configuration`, `resolveHeaders`, and
`serve(configurationPath)`. Unlike `createServer`, `serve` owns the complete stdio
process lifetime, including configuration loading and shutdown listeners. Importing
the package alone starts neither path. See the [public exports](src/index.ts).

## How it works

```text
configuration -> connect upstream -> snapshot tools and compile schemas
  -> add local discovery -> fixed-policy QuickJS executor -> MCP execute server

agent code -> worker/guest -> host tool adapter -> upstream MCP
           <- processed result and compact call summaries
```

Composition rejects upstream names `searchTools` and `describeTool` rather than
overwriting them. The MCP adapter borrows an executor; this package selects QuickJS
and describes its actual environment to the agent.

EOF, SIGINT, and SIGTERM cancel active executions and await worker cleanup before
closing the upstream. Stdio shutdown observes the child's actual close event;
HTTP shutdown requests session deletion when supported, with a 5-second DELETE
request timeout. The agent-facing transport opens during upstream setup, so EOF
can also cancel a stalled handshake or discovery.

[`cli.ts`](src/cli.ts) is the executable entry; [`main.ts`](src/main.ts) handles
arguments and exit status. [`composition.ts`](src/composition.ts) selects policy;
[`server.ts`](src/server.ts) explains startup and cleanup ordering beside the code.

`bun run build` emits `dist/cli.js` with a Bun shebang. After installing a packed
build, invoke it as `cmg configuration.json`; dependencies are not bundled.

## Current scope

One upstream, a startup catalog snapshot, and agent-facing stdio only. HTTP refers
to the upstream connection, not remote agent hosting. There is no model loop,
multi-upstream routing, persistence, or Node support. Cancellation cannot roll back
upstream side effects. Real-upstream validation, performance measurement, and
aggregate/payload resource hardening remain future work.

## Development

From the workspace root:

```sh
bun run --cwd packages/gateway test
bun run --cwd packages/gateway check
```

This package owns configuration, composition, CLI, end-to-end gateway, and
stdio/HTTP shutdown tests under `tests/`. Its helpers and upstream fixtures are
package-local. Packed-consumer fixtures additionally verify the installed API
and `cmg` executable through the root distribution checks.
See [testing conventions](../../docs/testing.md).
