# codemode-mcp-gateway

A code-mode gateway for MCP tools, built from reusable execution and MCP adapter
packages. An agent writes JavaScript; the gateway executes it with explicitly
supplied tools. The libraries do not run an agent/model loop.

## Packages

| Workspace                                            | Purpose                                                                      | Status                                                |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| [`@cmg/codemode`](packages/codemode/README.md)       | Standalone JavaScript execution, host-tool contracts, discovery, and reports | Independently packable; unpublished, provisional name |
| [`@cmg/mcp`](packages/mcp/README.md)                 | Connected MCP client → tools; supplied executor → MCP server                 | Private while API matures                             |
| [`codemode-mcp-gateway`](packages/gateway/README.md) | Programmatic composition and the `cmg` executable                            | Private while API matures                             |

```text
packages/gateway ──→ @cmg/mcp ──→ codemode's public tool/report contracts
           └──────→ @cmg/codemode (the selected QuickJS execution implementation)
```

Codemode can be used without MCP. MCP does not instantiate a sandbox: the
application injects execution. A replacement backend needs an adapter that honors
the report/cancellation contract and documents any differences in completion or limits.

Bun **1.4.2** is the supported host runtime, pinned in `.bun-version`. An npm
package does not imply Node compatibility. This is a working MVP, not a
production-hardened or OS-isolated sandbox.

## Run

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
bun run example
bun run example:mcp
bun run example:server
bun run check
```

Builds emit ESM JavaScript and declarations into each workspace's `dist/`,
including the codemode worker. Dependencies are not bundled. Package export maps
expose only public roots, not runtime deep imports. Repository scripts use the
`development` condition to select source; installed consumers use compiled exports.

## Standalone execution

```ts
import { CodemodeSandbox, ToolResult } from "@cmg/codemode";

const sandbox = new CodemodeSandbox({
  tools: { answer: () => ToolResult.success(42) },
});
const report = await sandbox.execute("return await tools.answer();");
```

Each execution gets a fresh worker and VM. Policy stays constructor-owned; request
options contain cancellation only. Tools run on the main thread and cross JSON.
Expected guest failures resolve in the report; infrastructure failures reject.
See the [codemode README](packages/codemode/README.md) for the public API, defaults,
ownership, cancellation, and limitations.

## Agent-facing service

```sh
bun run cmg examples/cmg.json
```

The `cmg` executable speaks MCP on stdin/stdout and exposes one tool, `execute({ code })`. It
connects one upstream over stdio or Streamable HTTP, builds a catalog, rejects
discovery-helper collisions, and supplies a fixed-policy QuickJS executor.

```js
return await tools.searchTools({ query: "add numbers" });
```

Then inspect an exact name with `tools.describeTool({ name: "add" })` and call it:

```js
return (await tools.add({ a: 2, b: 3 })).structuredContent.sum;
```

The response contains the final result and compact call summaries, not retained
tool bodies. The [gateway README](packages/gateway/README.md) covers configuration,
authentication headers, process ownership, and shutdown. HTTP support is upstream
only; remote agent hosting is not implemented.

## Distribution checks

```sh
bun run verify:packages
```

This builds and packs all workspaces, inspects their contents, and installs the
tarballs into unrelated temporary consumers. Codemode is checked independently
without MCP dependencies. The checks typecheck declarations, execute/cancel real
workers, exercise the MCP adapter and gateway API, and launch the packaged `cmg` executable.
Temporary local overrides stand in for unpublished workspace registry versions.
No package is published by these commands.

## Development

Each package owns its `tests/`, support helpers, fixtures, and test/check commands:

```sh
bun run --cwd packages/codemode test
bun run --cwd packages/mcp test
bun run --cwd packages/gateway test
```

Package-local `check` also runs typechecking, lint, and formatting checks. Root
`bun run check` coordinates builds, all package checks, and packed-install verification;
it does not own a separate test suite. Use `bun run format` for formatting.

- [Project conventions](AGENTS.md)
- [Testing conventions](docs/testing.md)
- [Detailed behavioral and ownership reference](docs/reference.md)
- [Codemode package](packages/codemode/README.md)
- [MCP package](packages/mcp/README.md)
- [Gateway package and CLI](packages/gateway/README.md)

## Status and milestones

Completed slices:

1. Synchronous QuickJS execution.
2. Async host-call bridge with explicit `ToolResult`.
3. Private guest prelude and wrapper validation.
4. Worker-backed execution.
5. Worker-backed host tools, catalog, and discovery.
6. Guest and opt-in parent deadlines.
7. Caller and cooperative host-tool cancellation.
8. Execution reports with retained responses and interruption reasons.
9. Memory, stack, and source limits.
10. Tool-call and concurrency limits.
11. Final guest-output limits.
12. MCP client adapter with bounded discovery and stdio lifecycle coverage.
13. Typed Standard Schema tools and compiled MCP input validation.
14. Fixed, constructor-owned sandbox policy and reusable tool bindings.
15. Execute-only MCP server with in-script discovery and a single upstream connection.
16. HTTP upstreams with host-supplied authentication and session cleanup.
17. Single-dispatcher guest protocol with prelude-owned promises and execution-level wakeups.
18. Documented workspaces, injected MCP execution, compiled ESM/declarations, and packed-consumer checks.
19. Package-owned tests and the `codemode-mcp-gateway` product package with separate API and `cmg` CLI entries.

Next: real-upstream validation, soak/fault testing, latency/memory measurements,
and payload/retention bounds based on integration evidence. Current guest limits
do not bound aggregate concurrent memory or retained tool-response bytes.
