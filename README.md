# codemode-mcp-gateway

A code-mode gateway for MCP tools, built from reusable execution and MCP adapter
packages. An agent writes JavaScript; the gateway executes it with explicitly
supplied tools. The libraries do not run an agent/model loop.

Requires Bun **1.4.2**, pinned in `.bun-version`. The package names are provisional
and nothing has been published. This is a working MVP, not an OS-isolated or
production-hardened sandbox.

## Run

```sh
bun install --frozen-lockfile --ignore-scripts
bun run example:server
```

The example starts a client, the gateway, and a synthetic upstream MCP server.
It discovers `add`, describes its schema, and returns the sum of 2 and 3. See
the [gateway guide](packages/gateway/README.md) to configure your own upstream.
Repository commands run source directly; a build is not required for these examples.

## Standalone execution

```ts
import { CodeExecutor, ToolResult } from "@cmg/codemode";

const sandbox = new CodeExecutor({
  tools: { answer: () => ToolResult.success(42) },
});
const report = await sandbox.execute("return await tools.answer();");
console.log(report.result); // { ok: true, value: 42 }
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

Library and gateway reports contain the final result and compact call summaries.
Scripts receive complete tool results; call summaries store no response bodies or
arguments. The [gateway README](packages/gateway/README.md) covers configuration,
authentication headers, process ownership, and shutdown. HTTP support is upstream
only; remote agent hosting is not implemented.

For an OAuth-protected upstream, explicitly log in before serving:

```sh
bun run cmg login examples/notion.json
bun run example:notion examples/notion.json "your test page"
```

The [local OAuth guide](packages/gateway/README.md#local-oauth) covers OS credential
storage, refresh/ownership, logout, and current platform/provider limitations.

## Packages

Choose the smallest layer your application needs:

| Package                                              | Use it for                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| [`@cmg/codemode`](packages/codemode/README.md)       | Execute JavaScript with your own host tools, without MCP              |
| [`@cmg/mcp`](packages/mcp/README.md)                 | Adapt a connected MCP client or expose your executor as an MCP server |
| [`codemode-mcp-gateway`](packages/gateway/README.md) | Use the composed service through its API or the `cmg` executable      |

Codemode owns execution. MCP depends on its public tool/report contracts, not
its runtime, and borrows an executor. Gateway selects QuickJS, supplies discovery,
and owns configuration and process lifecycle. MCP and gateway remain private;
codemode is independently packable. All three support Bun only.

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

Builds emit ESM JavaScript and declarations into each package's `dist/`, including
the codemode worker. Dependencies are not bundled. Export maps expose only package
roots; repository scripts use the `development` condition, while installed consumers
use compiled exports. Relative source imports use `.ts`; TypeScript rewrites them
to JavaScript extensions during the build.

## Real-upstream validation and execution baseline

Run the read-only Notion workflow after explicit login:

```sh
bun run cmg login examples/notion.json
bun run example:notion examples/notion.json "specific search phrase" \
  --page "<page-url-or-id>" --expect "<known text on the page>" --runs 3
bun run baseline 200
```

The Notion runner validates discovery, required search/fetch input schemas, the
provider's JSON text-block response shape, the expected page in the first ten search
results, and the fetched page ID and text marker. Use a sufficiently specific query.
Omit `--page` for discovery/search only; omit `--expect` to check fetch identity and
nonempty text without a content marker. The existing positional page argument also
works. `--runs` defaults to 1 and accepts 1–20 sequential iterations on one connection.
Failures stop the run, exit nonzero, and identify the step without printing provider
bodies. Login remains interactive; serving uses saved credentials.

Both commands emit JSON lines. Live `elapsedMs` measures each client request through
response validation; startup measures process launch through MCP initialization.
Shutdown measures EOF through observed child close, requiring exit code zero and no
signal. A 10-second shutdown watchdog makes forced termination a failure.
`responseJsonBytes` counts UTF-8 serialized agent-facing MCP JSON, including its text
and structured representations; it is not wire size. `upstreamJsonCharacters` counts
UTF-16 code units of serialized provider JSON inside the guest, not bytes.

The local baseline accepts 2–200 runs per workload (default 20), using public
`CodeExecutor` APIs with default limits. It checks scalar results and known 1 KiB /
1 MiB serialized tool results, returning only their text length. `toolResponseBytes`
is the known UTF-8 JSON size of the fixture, measured outside execution, not a retained
report body. Each run verifies metadata-only calls and awaits
worker cleanup. It retains numeric measurements rather than previous execution
reports, uses no forced GC, and samples process-wide RSS every 5 ms and after each
execution. RSS includes worker/WASM allocations; sampled peaks can miss short spikes.
All three workloads share one process, so memory and first-run timings are affected
by earlier workloads. These are observations, not performance thresholds.

### Observed baseline

Measured on macOS arm64 with Bun 1.4.2 before the summary-only report change:

| Live Notion check (3 iterations)            | Observation                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| Browser OAuth + OS credential persistence   | Login succeeded; subsequent gateway processes authenticated without prompting |
| Discovery                                   | 56 tools matched the search; search/fetch required schemas validated          |
| Known-page search and fetch                 | All three iterations verified page identity and a content marker              |
| Startup / EOF shutdown                      | 1,069 ms / 43 ms; natural exit code 0                                         |
| Search latency                              | 678–2,953 ms, median 958 ms                                                   |
| Fetch latency                               | 375–417 ms, median 405 ms                                                     |
| Fetch provider JSON / agent-facing response | 33,620 UTF-16 code units / 512 UTF-8 bytes                                    |

The live run used `examples/notion.json` (30-second guest / 45-second total deadline).
Queries, page IDs, and contents are not stored in this repository. Actual token
refresh, revocation, and provider outages were not exercised by this run; their
synthetic coverage remains separate from this evidence.

| Local workload (200 runs each, in order) | First run | Subsequent median (range) | RSS before → after |
| ---------------------------------------- | --------- | ------------------------- | ------------------ |
| Scalar                                   | 27.7 ms   | 22.9 ms (21.3–33.2)       | 19.2 → 177.3 MiB   |
| 1 KiB tool JSON                          | 24.3 ms   | 23.9 ms (22.3–36.5)       | 177.4 → 200.8 MiB  |
| 1 MiB tool JSON                          | 35.8 ms   | 35.8 ms (34.5–50.8)       | 201.3 → 289.2 MiB  |

RSS rose even for scalar executions; this short run did not distinguish runtime
caching, allocator retention, delayed GC, or a leak. The follow-up below isolates
a reproduction outside CMG. At measurement time, the 1 MiB tool response was
also retained in the report despite the 256 KiB final-output limit. Reports now
keep only call metadata; scripts still receive complete responses. These historical
measurements do not quantify that change or bound temporary transport allocations.

### Repeated-execution memory investigation

```sh
bun run baseline:memory --scenario executor --runs 1000 --batch-size 100
bun run baseline:memory --scenario wasm-memory --runs 3000 --batch-size 100 --gc forced
bun run baseline:memory --scenario quickjs --runs 1000 --worker-exit natural
bun run --cwd packages/codemode build
bun run baseline:memory --scenario executor --runs 1000 --mode compiled
```

[`scripts/memory-baseline.ts`](scripts/memory-baseline.ts) launches a fresh subprocess
per invocation. `--scenario` selects increasingly complete workloads:

| Scenario      | Work performed per iteration                                                               |
| ------------- | ------------------------------------------------------------------------------------------ |
| `control`     | Await an empty operation; measure harness overhead                                         |
| `worker`      | Create a Bun worker, receive 42, await termination and exit                                |
| `wasm`        | Worker compiles/instantiates a tiny WASM function returning 42, with no linear memory      |
| `wasm-memory` | Worker creates a 16 MiB `WebAssembly.Memory` and touches one byte                          |
| `quickjs`     | Worker loads QuickJS, evaluates 42, disposes the result/context/runtime, verifies disposal |
| `executor`    | Call public `CodeExecutor.execute("return 42;")`; require success and no calls             |

Runs are sequential. Defaults are 1,000 runs in batches of 100; accepted ranges are
1–10,000 runs and 1–1,000 per batch. Reports and worker references leave the operation
scope before each measurement. The harness keeps counters and batch timing totals,
not an accumulating history of reports or samples. JSON lines contain environment,
before/batch/one-second-idle snapshots, per-batch RSS deltas, and latency min/mean/max.
Repeat commands in fresh processes to assess variability; run performance comparisons
serially. The direct probes count started workers, replies, exit events, and awaited
terminations. These counts are not observed through the public executor and are
labelled accordingly. Worker hangs and an overall watchdog fail the command.

`--gc natural` leaves collection automatic. `--gc forced` calls `Bun.gc(true)` before
each snapshot on the **main thread**; Bun documents this as both JSC collection and
mimalloc cleanup, so it is not a JS-only intervention. RSS covers the process;
`heapStats()` describes the main thread's JSC heap, with some fields reflecting the
last collection. Natural-mode object counts can include uncollected garbage.
`native.currentCommit` is Bun's reported mimalloc commitment, not live application
bytes or RSS. No memory threshold is used as a correctness assertion.

The direct worker probes default to parent termination after the reply, like CMG.
`--worker-exit natural` instead closes the worker's port and requires normal exit;
it applies only to direct probes. `--mode compiled` loads the public executor through
its built export map; build codemode first. The environment record includes the
resolved executor entry. Probe fixtures remain TypeScript in either mode.

Observed on Apple M3 Pro, Darwin 25.6.0, Bun 1.4.2 (`744846f84437`), QuickJS SDK
0.32.0; batches of 100 with automatic GC:

| Workload                        | RSS before → after 1,000 + idle | Main JSC heap after idle |
| ------------------------------- | ------------------------------- | ------------------------ |
| Control                         | 29.3 → 34.1 MiB                 | 1.4 MiB                  |
| Bare worker, two fresh runs     | 28.3–31.0 → 55.6–55.9 MiB       | 2.4 MiB                  |
| WASM function without memory    | 29.5 → 62.3 MiB                 | 2.4 MiB                  |
| WASM memory, two fresh runs     | 29.0–31.0 → 73.3–80.9 MiB       | 2.4 MiB                  |
| QuickJS worker, two fresh runs  | 28.8–31.4 → 217.9–233.0 MiB     | 2.3 MiB                  |
| Source executor, two fresh runs | 30.4–32.8 → 247.8–254.6 MiB     | 2.7 MiB                  |
| Compiled executor               | 31.0 → 242.3 MiB                | 2.7 MiB                  |

Every direct worker run observed all 1,000 replies and exits. After warmup, the
bare-worker and memory-free WASM commitment measurements levelled off in this window.
The WASM-memory, QuickJS, and executor runs continued increasing. A one-second idle
did not materially reduce RSS. Natural exit reproduced growth for both WASM-memory
and QuickJS workers (77.9 / 212.3 MiB final RSS, zero forced terminations).

Forced main-thread GC did not eliminate growth. In a 3,000-worker WASM-memory run,
RSS grew from 32.6 to 118.3 MiB, while the main JSC heap stayed near 2.3 MiB after
warmup. Reported native commitment at 1,000 / 2,000 / 3,000 was 185.5 / 248.1 / 311.4
MiB—approximately 64 KiB per additional worker. The probe observed all 3,000 exits.
This does **not** mean each worker retained its entire 16 MiB linear memory.

**Conclusion:** continuing native-memory growth is reproducible in Bun's
WebAssembly-memory worker lifecycle without CMG or QuickJS. Main-thread forced GC,
natural worker exit, and compiled executor exports do not remove the observed trend.
The exact retained native allocation is not identified, and these measurements do
not exclude additional CMG overhead or prove indefinite growth. No CMG ownership
defect was demonstrated, so this investigation adds diagnostics rather than changing
execution lifetimes. The small reproduction is preserved in
[`scripts/fixtures/memory-worker.ts`](scripts/fixtures/memory-worker.ts).

Report-body retention has since been removed independently of this runtime finding.
Runtime-level investigation can use the WASM-memory reproduction; metadata-only
reports do not fix growth already observable with scalar executions.

## Development

Each package owns its `tests/`, support helpers, fixtures, and test/check commands.
Tests are organized by public module contract, with real implementations and a small
set of process/distribution checks. See the [testing conventions](docs/testing.md).

```sh
bun run check
bun run example
bun run example:mcp
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
8. Execution reports and interruption reasons (response-body retention removed in slice 23).
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
20. Single-user local OAuth login/logout, OS-backed credentials, noninteractive refresh,
    cross-process refresh coordination, and a read-only Notion smoke example.
21. Live Notion login/search/fetch validation, independently checked smoke outcomes,
    natural-exit measurement, and a reproducible sequential execution/RSS baseline.
22. Isolated worker/QuickJS/executor memory diagnostics, with a smaller Bun
    WebAssembly-memory reproduction and source/compiled, GC, and exit-mode comparisons.
23. Metadata-only call reports across the library, infrastructure errors, and gateway;
    complete tool responses remain available to scripts, with no retention option.

Next: bounded concurrent executions, tool-payload bounds, runtime-level follow-up on the WASM-memory reproduction,
and longer soak/fault testing based on integration evidence. Current guest limits
do not bound aggregate concurrent memory or temporary tool-response allocations.
