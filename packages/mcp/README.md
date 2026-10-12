# @cmg/mcp

Two adapters between MCP and code-mode execution:

1. `createMcpCatalog(client)` adapts an already-connected MCP client's tools.
2. `createCodemodeServer({ execute })` exposes an application-supplied executor as
   one MCP tool, `execute({ code })`.

This package does not choose or instantiate QuickJS, create upstream transports,
read configuration, perform authentication, or own application shutdown signals.
It uses `@cmg/codemode`'s public tool/report contracts, not its runtime internals.
The name is provisional; the package remains private while its API matures.

## Composition example

```ts
import { CodemodeSandbox, createDiscoveryTools } from "@cmg/codemode";
import { createMcpCatalog, createCodemodeServer } from "@cmg/mcp";
import { type Client } from "@modelcontextprotocol/client";

// The caller connects/authenticates client and retains ownership of it.
export async function compose(client: Client) {
  const catalog = await createMcpCatalog(client);
  const discovery = createDiscoveryTools(catalog);
  for (const name of Object.keys(discovery)) {
    if (Object.hasOwn(catalog.tools, name)) throw new Error(`Tool collision: ${name}`);
  }
  const sandbox = new CodemodeSandbox({
    tools: { ...catalog.tools, ...discovery },
  });
  return createCodemodeServer({
    execute: (code, options) => sandbox.execute(code, options),
    description: "Run JavaScript; discover tools with tools.searchTools({ query }).",
  });
}
// The caller connects the returned server to an SDK transport and awaits server.close().
```

An alternative executor can be supplied without changing the MCP server. It must
honor the cancellation signal, produce `ExecutionReport`, and settle only after
its owned execution cleanup. Matching TypeScript types does not make differing
backend behavior equivalent: drain-on-success, limits, privacy, and report
semantics must be implemented or explicitly documented by the application.

Previously, `createCodemodeServer` accepted `catalog` and `sandbox`. Construct the
executor in application code instead, and supply `execute` as shown above.
Discovery injection and collision handling have also moved to the application.

## Upstream catalog

`createMcpCatalog(client, { timeoutMs, signal }?)` lists tools and compiles input
schemas once. Discovery defaults to a 15-second overall deadline, including
listing and schema compilation. The returned catalog is a startup snapshot;
there is no automatic refresh or subscription to upstream changes.

- The client must already be connected. Ownership never transfers to this package.
- Setup failures reject on the host; duplicate names or invalid schemas reject discovery.
- Omitted tool arguments normalize to `{}`. Non-object or schema-invalid arguments
  fail before upstream dispatch.
- JSON Schema 2020-12 and draft-07 are supported without coercion or default insertion.
- Tool responses retain `content`, optional `structuredContent`, and optional `isError`.
- Upstream `isError` is data the script can inspect, not an inferred sandbox failure.
- Invocation uses the execution signal, not the discovery signal. Cancellation is cooperative.

## Agent-facing server

`createCodemodeServer({ execute, description? })` returns an MCP SDK `McpServer`.
It accepts only a string `code`; resource configuration remains application-owned.
Discovery helpers are not automatically injected: the application supplies the
executor's tools and a truthful description of its environment.

Responses contain the final result and compact call summaries, as both text JSON
and structured content. Completed summaries omit retained tool bodies and do not
guarantee external success. Unsuccessful executions set outer MCP `isError: true`.
Infrastructure rejections become a controlled `sandbox` error; original causes
are delivered only to the host SDK error hook. A throwing hook cannot replace the
controlled response with private details.
Adapters can throw `SandboxExecutionError(calls, cause)` to preserve infrastructure
call observations; other rejection reasons produce an empty call summary.

Closing aborts server-owned requests and awaits their executor promises. It does
not close an upstream client or globally dispose a shared executor. Consequently,
the injected executor must respond to cancellation and await its cleanup before
settling. Node compatibility is not tested; Bun 1.4.2 is the supported runtime.

## Development

From the workspace root:

```sh
bun run --cwd packages/mcp test
bun run --cwd packages/mcp check
```

This package owns catalog, schema, executor-adapter, and upstream lifecycle tests
under `tests/`. Helpers and synthetic upstream fixtures stay package-local;
integration tests use only codemode's public API.
See [testing conventions](../../docs/testing.md).
