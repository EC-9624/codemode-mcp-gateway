# @codemode-mcp-gateway/mcp

Two adapters between MCP and code-mode execution:

1. `createMcpCatalog(client)` adapts an already-connected MCP client's tools.
2. `createCodemodeServer({ execute })` exposes an application-supplied executor as
   one MCP tool, `execute({ code })`.

## Setup

Requires **Bun 1.4.3** and the full workspace for source examples. This package
remains registry-private; no registry installation command is established.
From the workspace root:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run --cwd packages/mcp example
bun run --cwd packages/mcp example:server
```

The first example adapts a synthetic stdio upstream and returns sum `5` in a host
report; the second exposes a borrowed executor and returns MCP text `42`. Their
sources and expected outcomes are in `packages/mcp/examples/` in the repository,
not tarballs. Build from the full workspace before packing local compiled consumers.
Import package roots without the `development` condition in installed consumers.

## Usage

```ts
import { CodeExecutor } from "@codemode-mcp-gateway/codemode";
import { createMcpCatalog, createCodemodeServer } from "@codemode-mcp-gateway/mcp";
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
`createDiscoveryTools` explicitly, or use `codemode-mcp-gateway`, which supplies
discovery and qualifies upstream names so they cannot overwrite its helpers.
An upstream `searchTools` stays callable as `tools["server.searchTools"]`.
The root shortcut `bun run example:mcp` runs the client-adapter example.

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
An optional host `onClose(): Promise<void>` releases presentation resources only
after those requests drain. Close awaits it, runs it once, and preserves host-side
cleanup failures. It does not dispose the borrowed executor or upstreams.

Catalog setup failures reject before an executor is used. Omitted tool arguments
normalize to `{}`; non-object or schema-invalid arguments fail before upstream
dispatch. Invocation `ProtocolError`s reject with the tool name, numeric code, and
message, including SDK-generated output-schema errors. Error data and stacks are
not forwarded. Messages are treated as public and are not redacted; upstreams must
not put secrets in them. Other invocation exceptions still become `Host tool failed.`
The original cause is available to the executor's host-only `onToolException` observer
for both cases.

## Discovery and limits

`createMcpCatalog(client, { timeoutMs, signal, onToolResponse }?)` lists tools and compiles input
schemas once. Discovery defaults to a 15-second overall deadline, including
listing and schema compilation. The returned catalog is a startup snapshot;
there is no automatic refresh or subscription to upstream changes.

- The client must already be connected. A server without tools yields an empty catalog.
- Duplicate names and invalid input schemas reject discovery.
- JSON Schema 2020-12 and draft-07 are supported without coercion or default insertion.
- Tool responses retain `content`, optional `structuredContent`, and optional `isError`,
  but not top-level `_meta` or unrelated extension fields.
- Synchronous schema compilation cannot be interrupted; the deadline is checked afterward.

`onToolResponse(context, isError)` is an optional synchronous, metadata-only hook
at the MCP response boundary. It receives the caller's `ToolContext` and the known
MCP error flag, never response contents. It is not called for validation failures
or protocol exceptions without a response. Throwing observers reject the invocation;
applications must contain their own best-effort telemetry failures. The adapter does
not interpret arbitrary returned JSON as an error or import an observability SDK.

The server's `execute` tool accepts only `{ code: string }`. Limits stay in the supplied
executor; request arguments cannot override them. This adapter adds no tool-payload
byte limit. Scripts receive the complete retained content/structured content.
Unsupported schema dialects, external references, and asynchronous JSON Schemas
reject catalog setup; no external schemas are fetched. Upstream messages must
not contain credentials because public protocol messages are deliberately preserved.

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
listeners. `dist/index.d.ts` contains the supported public signatures and options.
Repository implementation references (`src/catalog.ts`, `src/server.ts`, and
`src/types.ts`) are not shipped or supported deep imports.

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
Repository testing conventions live in `docs/testing.md`; it is not shipped here.
