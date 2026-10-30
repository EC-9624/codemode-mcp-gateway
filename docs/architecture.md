# Architecture and ownership

## Package boundaries

```text
codemode-mcp-gateway (composition, CLI, transports, upstreams)
  ├── @codemode-mcp-gateway/mcp (MCP adapters)
  │     └── @codemode-mcp-gateway/codemode (execution and tools)
  └── @codemode-mcp-gateway/codemode
```

- **Codemode** owns execution policy, worker admission/supervision, QuickJS, and
  the host/guest serialization boundary. It has no MCP or gateway dependency.
  Worker and VM implementation lives under `packages/codemode/src/runtime/`.
- **MCP** adapts connected clients into catalogs and borrowed executors into
  servers. It imports codemode's public API, not its runtime. The application
  supplies the executor; the adapter does not choose or construct an engine.
- **Gateway** is the composition root. It chooses the executor, opens upstreams,
  supplies discovery, and exposes shared execution through MCP sessions.
  Importing `packages/gateway/src/index.ts` does not start serving or register
  process listeners; `src/cli.ts` is the executable entry point.

Published imports use package-root export maps. Internal relative imports stay
within the owning package. Tests use another package's public API, never its
implementation or test helpers. Source runs select the `development` condition;
installed consumers load compiled `dist/` artifacts.

## Codemode structure

| Location                  | Responsibility                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `catalog.ts`              | Tool definitions, metadata/callback snapshots, and exact-name lookup                                              |
| `search.ts`               | Text tokenization/plural aliases, exact-name/name-coverage preferences, substring eligibility, and stable ranking |
| `bm25.ts`                 | Corpus frequency statistics and the BM25 scoring function, independent of tool names and discovery                |
| `discovery.ts`            | Discovery argument validation, description previews, pagination, and the public page type                         |
| `executor.ts`, `runtime/` | Host admission/supervision and worker-local QuickJS execution                                                     |

The search policy delegates numeric scoring to `createBm25`; the `bm25` function
contains the scoring formula. BM25 receives pretokenized documents with opaque
values, and search requires only names/descriptions while preserving complete
metadata in its results. Neither module imports catalog types, avoiding a type
dependency cycle. Discovery depends on the catalog contract, not the scoring
implementation. These modules remain internal: callers and tests use the same
package-root catalog/discovery API.

## Gateway structure

| Location                           | Responsibility                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `gateway.ts`                       | Shared executor, upstream coordination, catalog revisions, and MCP session ownership      |
| `server-status.ts`, `tool-list.ts` | Shared public data contracts, independent of connection lifecycle implementation          |
| `catalog.ts`                       | Namespaced catalog metadata and discovery bindings                                        |
| `upstream/`                        | Connection setup, availability, recovery, and retained connection leases                  |
| `auth/`                            | Explicit login/logout, credential stores, refresh/session behavior, and credential leases |
| `http/`                            | Authenticated loopback HTTP, management endpoints, and HTTP session lifetime              |
| `stdio/`                           | Stdio process serving and EOF-driven shutdown                                             |
| `cli/`                             | Command parsing, dispatch, setup, selection, and terminal/pipe presentation               |
| `observability/`                   | Allowlisted events, logging, metrics, and tracing                                         |

Data contracts sit below their producers and consumers. For example, HTTP response
validation, CLI rendering, telemetry, and `Upstream` all depend on
`server-status.ts`; none needs to import `Upstream` merely to describe status.
Event state types derive from that same contract rather than maintaining another
list of states.

## Resource ownership

| Owner                                 | Owned resources and cleanup boundary                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `CodeExecutor` / execution supervisor | Fixed execution policy; each admitted execution owns a worker and its termination                                         |
| Worker-local engine                   | Fresh QuickJS VM, bridge handles, and guest execution cleanup                                                             |
| MCP adapter                           | Its request cancellation and execution/output drain; the executor and upstream client remain borrowed                     |
| `Gateway`                             | Executor, upstreams, maintenance, and created MCP servers; injected logger/telemetry remain borrowed                      |
| `Upstream` / connection               | Transport, MCP client, OAuth session, and catalog revision; retired connections stay alive while executions retain them   |
| `GatewayHttpServer`                   | HTTP listener and HTTP MCP sessions; the gateway remains borrowed                                                         |
| `serve` / `serveHttp`                 | Serving lifetime, scoped process listeners, and environment-created telemetry; caller-supplied telemetry remains borrowed |

Recovery publishes new catalogs for later executions without changing bindings
already retained by running scripts. Shutdown drains execution and output before
retiring upstream resources. Cancellation does not roll back tool side effects
or guarantee that a host callback has stopped.

## Audit findings and guardrails

The architecture audit retained the three-package split: execution, protocol
adaptation, and product composition already have distinct ownership. Creating
more packages or merging HTTP/stdio lifecycle handling would add indirection
without an established reuse need. HTTP must bind before opening upstreams;
stdio must observe EOF, including during initialization.

The concrete structural issue was `ServerStatus` living inside
`upstream/upstream.ts`. This made management validators depend on connection/auth
implementation and created type-level cycles through catalog and telemetry.
Moving it to `server-status.ts` removes those cycles without changing the public
package API or wire format.

Oxlint now checks local import cycles, including type-only imports, and rejects
static imports/re-exports through workspace package internals or deep package
paths. These are focused guardrails, not a complete dependency-policy checker:
computed dynamic imports and package dependency direction still require review.
The packed-consumer checks separately verify export maps, declarations, workers,
and actual installed behavior.

Run `bun run check` and `bun run example` after structural changes. Package-local
checks are documented in [testing conventions](testing.md); runnable diagnostics
remain separate from normal verification in the [script guide](../scripts/README.md).
