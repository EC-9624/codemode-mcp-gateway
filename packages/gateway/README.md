# codemode-mcp-gateway

A Bun stdio gateway that lets coding agents discover and compose one upstream
MCP server's tools through JavaScript. This product package provides both a
programmatic API and the `cmg` executable, composing `@cmg/codemode` and `@cmg/mcp`.
The package remains private while its API matures.

```text
Agent → MCP execute({ code }) → CMG → QuickJS worker → host tool adapter → upstream MCP
```

## Run from the repository

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
bun run cmg examples/cmg.json
bun run example:server
```

The build provides `dist/cli.js` as the package's `cmg` executable, with a Bun
shebang. After installation, run `cmg configuration.json`. Stdout is exclusively
MCP traffic; diagnostics use stderr. `src/cli.ts` calls `main(argv)`; argument
handling is separate from service startup and cleanup.

## Programmatic API

```ts
import { createServer } from "codemode-mcp-gateway";

// catalog is an application-owned ToolCatalog.
const server = createServer(catalog, { timeoutMs: 5_000 });
// Connect an application-owned MCP transport, then await server.close().
```

The public entry also exports `Configuration`, `resolveHeaders`, and
`serve(configurationPath)`. `serve` runs the same stdio service as the CLI,
including EOF and process-signal shutdown handling. Importing the package alone
does not read arguments, start connections, or install process listeners.

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

## Agent workflow

The agent sees only `execute({ code })`. Begin with:

```js
return await tools.searchTools({ query: "what you need" });
```

Then describe an exact name with `tools.describeTool({ name })`, invoke it through
`tools[name](args)`, inspect upstream `isError`, and return a processed JSON value.
Local discovery helpers share the execution budget. Upstream helper-name collisions
reject startup rather than silently overwrite tools.

## Gateway ownership

- `config.ts` validates transport settings, app defaults, and host header templates.
- `cli.ts` is the executable entry; `main.ts` handles arguments and exit status.
- `composition.ts` combines upstream tools with discovery, selects our sandbox,
  and supplies its execution callback and environment description to the MCP server.
- `server.ts` owns configuration loading, upstream client/transport, the agent-facing
  stdio connection, signals, startup negotiation, and shutdown.

EOF, SIGINT, and SIGTERM cancel active executions and await worker cleanup before
closing the upstream. Stdio shutdown observes the child's actual close event;
HTTP shutdown requests session deletion when supported, with a 5-second DELETE
request timeout. These lifecycle rules apply during partial startup as well.

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
