# @cmg/mcp

Two adapters between MCP and code-mode execution:

1. `createMcpCatalog(client)` adapts an already-connected MCP client's tools.
2. `createCodemodeServer({ execute })` exposes an application-supplied executor as
   one MCP tool, `execute({ code })`.

## Usage

```ts
import { CodeExecutor } from "@cmg/codemode";
import { createMcpCatalog, createCodemodeServer } from "@cmg/mcp";
import { type Client } from "@modelcontextprotocol/client";

// The caller connects/authenticates client and retains ownership of it.
export async function compose(client: Client) {
  const catalog = await createMcpCatalog(client);
  const sandbox = new CodeExecutor({ tools: catalog.tools });
  return createCodemodeServer({
    execute: (code, options) => sandbox.execute(code, options),
    description: "Run JavaScript as an async function body using the supplied upstream tools.",
  });
}
// The caller connects the returned server to an SDK transport and awaits server.close().
```

With the included upstream's `add` tool, an agent calls
`execute({ code: "return (await tools.add({ a: 2, b: 3 })).structuredContent.sum;" })`.
The server returns only useful display text:

```json
{
  "content": [{ "type": "text", "text": "5" }]
}
```

The MCP server does not instantiate QuickJS or inject discovery. Use
`createDiscoveryTools` explicitly, or use the [gateway](../gateway/README.md),
which supplies discovery and rejects helper-name collisions. The complete
[upstream example](../../examples/mcp.ts) runs with `bun run example:mcp`.

## Results and failures

There are two different error signals:

- **Upstream `isError`:** remains inside the tool's response. A script can inspect
  or handle it; returning that flag normally is still successful execution.
- **Outer MCP `isError`:** included only as `true` when execution or output delivery fails.

Strings are plain text; other values are compact JSON. No return becomes `null`.
Failures show the useful error message. There is no `structuredContent`, report
envelope, or call list in the agent-facing response. The executor still returns
its full host-side `ExecutionReport`; infrastructure causes and call observations
remain on `SandboxExecutionError`, delivered to the host SDK error hook.
Executor rejections become `Sandbox execution failed.`; a throwing diagnostic
hook cannot replace the controlled response or expose its own message.

An optional `formatOutput(text): Promise<string>` callback supplies host-owned
presentation, such as the gateway's temp-file spilling. Closing the server waits
for presentation as well as execution. Unexpected formatter errors produce a
controlled delivery error, without replaying the script.

Catalog setup failures reject before an executor is used. Omitted tool arguments
normalize to `{}`; non-object or schema-invalid arguments fail before upstream
dispatch. Invocation `ProtocolError`s reject with the tool name, numeric code, and
message, including SDK-generated output-schema errors. Error data and stacks are
not forwarded. Messages are treated as public and are not redacted; upstreams must
not put secrets in them. Other invocation exceptions still become `Host tool failed.`
The original cause is available to the executor's host-only `onToolException` observer
for both cases.

## Discovery and limits

`createMcpCatalog(client, { timeoutMs, signal }?)` lists tools and compiles input
schemas once. Discovery defaults to a 15-second overall deadline, including
listing and schema compilation. The returned catalog is a startup snapshot;
there is no automatic refresh or subscription to upstream changes.

- The client must already be connected. A server without tools yields an empty catalog.
- Duplicate names and invalid input schemas reject discovery.
- JSON Schema 2020-12 and draft-07 are supported without coercion or default insertion.
- Tool responses retain `content`, optional `structuredContent`, and optional `isError`,
  but not top-level `_meta` or unrelated extension fields.
- Synchronous schema compilation cannot be interrupted; the deadline is checked afterward.

The server's `execute` tool accepts only `{ code: string }`. Limits stay in the supplied
executor; request arguments cannot override them. This adapter adds no tool-payload
byte limit. Scripts receive complete upstream responses. See
[schema and protocol details](../../docs/reference.md#mcp-upstream-adapter).

## How it works

The adapters connect opposite sides of execution:

```text
upstream client -> list and compile schemas -> ToolCatalog callbacks
agent execute request -> supplied executor -> host report -> display text -> optional formatter
```

The catalog borrows a connected SDK client. Each tool callback validates arguments,
forwards the execution's cancellation signal, and wraps the MCP response in
`ToolResult.success`. The discovery signal does not carry into later calls.

Closing aborts server-owned requests and awaits their executor promises. It does
not close the borrowed upstream client or globally dispose a shared executor.
The application closes its connections after server cleanup. A replacement executor
must honor cancellation and settle after its own cleanup; matching TypeScript
types alone does not establish equivalent completion, limit, privacy, or report behavior.

This package depends only on codemode's public contracts. It does not create
upstream transports, perform authentication, read configuration, or install process
listeners. See the [catalog](src/catalog.ts), [server](src/server.ts), and
[public options](src/types.ts) for the boundary contracts.

Migration: `createCodemodeServer` now takes `execute`, not `catalog` and `sandbox`.
Discovery injection and collision handling belong to application composition.
Agent clients now read `content` instead of `structuredContent.result.value`;
`CodemodeResponse` and `CallSummary` are no longer exported.

## Development

From the workspace root:

```sh
bun run --cwd packages/mcp test
bun run --cwd packages/mcp check
```

The package is private and its name provisional. Bun 1.4.3 is the supported runtime;
Node compatibility is not an acceptance requirement.

Tests under `tests/` exercise the public catalog and server modules. Catalog tests
validate upstream schemas through discovered tools; server tests use real SDK
requests and injected executors. A small transport suite checks real execution,
cancellation, and child cleanup through public APIs. Helpers and synthetic
upstream fixtures stay package-local.
See [testing conventions](../../docs/testing.md).
