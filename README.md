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
Each executor admits up to four executions by default, including cleanup; configure
`maxConcurrentExecutions` to change that limit. Excess submissions fail immediately
with `limit / executions`, without starting a worker, queuing, or retrying.
Expected guest failures resolve in the report; infrastructure failures reject.
See the [codemode README](packages/codemode/README.md) for the public API, defaults,
ownership, cancellation, and limitations.

## Agent-facing service

```sh
bun run cmg examples/cmg.json
```

The `cmg` executable speaks MCP on stdin/stdout and exposes one tool, `execute({ code })`.
It supports named stdio/HTTP upstreams with partial availability and automatic
credential recovery.

Clients can launch installed `cmg` without arguments. Configuration defaults to
`$XDG_CONFIG_HOME/cmg/config.json` or `~/.config/cmg/config.json`; `--config <path>`
and a positional path override it. `cmg check`, `cmg doctor`, and
`cmg login --server <name>` provide validation, diagnostics, and authorization.
See [named upstreams and hot recovery](packages/gateway/README.md#named-upstreams-and-hot-recovery)
and [`examples/multi.json`](examples/multi.json). All upstream tools use `server.original-name`.

```js
return await tools.searchTools({ query: "add numbers" });
```

Search returns `{ tools, total, nextOffset, servers }`: five ranked name/short-description
previews by default, without schemas. Pick a relevant name from `tools`; inspect it
with `tools.describeTool({ name: "math.add" })` for its full description and schema, then call it once the server is connected:

```js
return (await tools["math.add"]({ a: 2, b: 3 })).structuredContent.sum;
```

For additional matches, repeat the query with `offset: nextOffset` until it is null.
`limit` changes the page size; see the [discovery contract](docs/reference.md#catalog-and-discovery).

The library keeps full host-side execution reports; the gateway sends only the returned
value or useful error text, with no bookkeeping envelope or `structuredContent`.
Above 40,000 UTF-8 bytes it shows a beginning/end preview and saves full output to
a private local file. Read it with native harness tools on the shared filesystem.
Files last until gateway shutdown; there is no custom artifact tool, TTL, or total
storage quota. Gateway hard output defaults to 16 MiB; the library keeps 256 KiB.
Scripts still receive complete upstream tool results. The [gateway README](packages/gateway/README.md) covers configuration,
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

For saved-credential Notion checks and an optional OpenCode session through an
installed executable, follow the [external-consumer workflow](docs/installed-validation.md).
The installed-agent follow-up passed using a preflighted shared-service location,
with one discovery-query clarification; the guide records both the readiness issue
and the successful checks.

Builds emit ESM JavaScript and declarations into each package's `dist/`, including
the codemode worker. The patched QuickJS SDK JavaScript is bundled so standalone
consumers receive the memory-growth fix; WASM variants and other dependencies stay
external. See [patch notes](patches/README.md). Export maps expose only package
roots; repository scripts use the `development` condition, while installed consumers
use compiled exports. Relative source imports use `.ts`; TypeScript rewrites them
to JavaScript extensions during the build.

## Real-upstream validation and execution baseline

Run the read-only Notion workflow after explicit login:

```sh
bun run cmg login examples/notion.json
bun run example:notion examples/notion.json "specific search phrase" \
  --page "<page-url-or-id>" --expect "<known text on the page>" --runs 3
# Overlap independent read-only workflows through the same gateway connection:
bun run example:notion examples/notion.json "specific search phrase" \
  --page "<page-url-or-id>" --expect "<known text on the page>" --agents 4 --runs 3
bun run baseline 200
```

The Notion runner validates discovery, required search/fetch input schemas, the
provider's JSON text-block response shape, the expected page in the first ten search
results, and the fetched page ID and text marker. Use a sufficiently specific query.
Omit `--page` for discovery/search only; omit `--expect` to check fetch identity and
nonempty text without a content marker. `--runs` defaults to 1 and accepts 1–20 sequential iterations on one connection.
`--agents` defaults to 1 and accepts 1–8 overlapping workflows per iteration, sharing
one executor. These are scripted workflows, not LLM agents. A failed workflow stops;
its peers finish before the runner exits nonzero, without starting another iteration.
Records identify the agent, step, and execution failure resource without printing
provider bodies. Capacity rejection is a smoke failure and is never retried. Login
remains interactive; serving uses saved credentials.

`examples/notion.json` sets `maxConcurrentExecutions` to 8 for multi-agent usage,
with its existing 30-second guest / 45-second total
deadlines. The library and gateway defaults remain 4 concurrent executions.
Guest memory now defaults to 256 MiB; historical measurements below used 64 MiB.

Both commands emit JSON lines. Live `elapsedMs` measures each client request through
response validation; startup measures process launch through MCP initialization and upstream readiness.
Shutdown measures EOF through observed child close, requiring exit code zero and no
signal. A 10-second shutdown watchdog makes forced termination a failure.
`responseJsonBytes` counts UTF-8 serialized agent-facing MCP JSON, not wire size.
Older measurements below included both text and structured representations.
`upstreamJsonCharacters` counts
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

The [WASM follow-up](docs/wasm-memory.md) narrows this to the fast-memory allocation
path and documents matching upstream page-map findings. It includes a dependency-free
[standalone reproduction](scripts/wasm-memory-repro.ts), ArrayBuffer/untouched-memory
controls, and opt-in macOS allocator/VM profiling (`--profile`).

### Shared-gateway concurrency diagnostic

```sh
bun run baseline:concurrency 5
```

This runs repeatable **simulated agent workflows**, not LLM agents or live-provider
traffic. Independent workflows multiplex requests over one in-memory MCP client
connection to one gateway/executor. A local MCP upstream exercises real discovery,
schema validation, tool dispatch, worker execution, and result serialization.

Each workflow discovers tools, describes their schemas, searches, then fetches two
64-KiB documents in parallel and returns only IDs and character counts. Search waits
150 ms, fetch waits 300 ms, and the client pauses 100 ms between execution requests.
Every successful result and host-side call summary is validated; unexpected tool, execution,
transport, or validation failures fail the diagnostic. Capacity rejections are
measured, end that workflow, and are never retried.

The matrix uses 1, 2, 4, and 8 workflows with the default capacity of 4, plus an
8-workflow comparison at capacity 8. Burst waves start together; staggered waves
space workflow starts by 150 ms. Each wave finishes before the next starts, so this
is a finite-wave diagnostic, not a sustained arrival-rate or fairness benchmark.

Each scenario runs in a fresh child process, warms one complete workflow, and uses
automatic GC. JSONL output includes workflow/request rejection rates, successful
workflow throughput, per-step p50/p95/max latency, and RSS sampled every 5 ms with a
one-second idle reading. RSS includes the gateway, client, and local upstream in
that process; it is neither isolated gateway memory nor a guaranteed peak. Timing
excludes connection setup and warmup; workflow timing includes client pauses but
not the initial stagger. The default five waves provide descriptive samples, not
capacity guarantees or production percentile estimates.

#### Observed concurrency results

Measured on Apple M3 Pro, Darwin 25.6.0, Bun 1.4.2 (`744846f84437`), five waves
per local scenario. All 230 attempted workflows produced validated results or
explicit capacity rejections: 199 completed and 31 were rejected. At 1, 2, and 4
workflows per wave, capacity 4 produced no rejections under either cadence.

| Workflows per wave | Cadence   | Capacity | Completed | Workflow rejection rate | Successful workflow p95 | Sampled peak RSS |
| ------------------ | --------- | -------- | --------- | ----------------------- | ----------------------- | ---------------- |
| 4                  | Burst     | 4        | 20/20     | 0%                      | 968 ms                  | 312 MiB          |
| 8                  | Burst     | 4        | 20/40     | 50%                     | 964 ms                  | 310 MiB          |
| 8                  | Burst     | 8        | 40/40     | 0%                      | 1,001 ms                | 451 MiB          |
| 8                  | Staggered | 4        | 29/40     | 27.5%                   | 906 ms                  | 340 MiB          |
| 8                  | Staggered | 8        | 40/40     | 0%                      | 918 ms                  | 380 MiB          |

At capacity 4, all burst rejections occurred at discovery. Staggered rejections
occurred at discovery (6) or description (5), showing that a workflow can start
successfully and later lose admission. Request rejection rates were 20% and 8.3%,
respectively; workflow rejection rates are higher because rejection ends a workflow.
Burst rejection p95 was 2 ms. Successful burst throughput increased from 4.17 to
7.99 workflows/second at capacity 8.

RSS after warmup was 125–130 MiB in these scenarios and rose across waves; the
one-second idle did not materially reduce it. Capacity 8 also completed more total
work, so its higher RSS combines overlap and cumulative worker/allocation effects.
These measurements do not isolate a per-slot memory cost.

Read-only live Notion workflows then exercised saved credentials, discovery,
schemas, known-page search, and fetch identity/content checks through one stdio
gateway connection:

| Overlapping workflows                           | Capacity | Observation                                                                                                    |
| ----------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| 4, three iterations                             | 4        | 12/12 completed; search p50 742 ms, fetch p50 388 ms                                                           |
| 8, one iteration                                | 4        | 4/8 completed; four rejected at discovery in 6–7 ms                                                            |
| 8, initially three requested iterations         | 8        | First iteration: seven completed; one search omitted the known page from its first ten results; runner stopped |
| 8, three iterations with a specific-title query | 8        | 24/24 completed; search p50/p95 898/2,643 ms, fetch p50/p95 395/691 ms                                         |

The initial capacity-8 run had a search-validation failure, not a capacity rejection;
its cause is unknown. Narrowing the query passed all subsequent checks, but does
not explain that earlier provider result. Queries differed, so these live timings
are not a controlled capacity comparison. Every gateway process exited naturally
with code zero; the smoke runner exited nonzero for capacity or validation failures.
No live-provider memory measurement or actual LLM-agent session was performed.

**Conclusion:** four slots work for these four-workflow runs but materially reject
eight-workflow traffic, including staggered traffic. Eight slots handled the tested
local and specific-query live workflows, with a higher local memory footprint.
This supports considering a higher setting for eight-way usage, not an unconditional
default increase. The default remains 4; no additional limits were introduced.

### Actual agent sessions through one gateway

OpenCode V2 can multiplex sessions at the same location over one local MCP
connection. Launching separate standalone OpenCode servers or using different
locations may instead create independent gateways. Verify sharing rather than
inferring it from overlapping agent runs.

For an integration run, configure an isolated OpenCode directory with this server
entry (replace the absolute paths):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "cmg": {
        "type": "local",
        "cwd": "/absolute/path/to/mcm",
        "command": [
          "bun",
          "scripts/observe-gateway.ts",
          "examples/notion.json",
          "/absolute/path/to/gateway-metadata.jsonl"
        ],
        "codemode": false,
        "protocol": "legacy"
      }
    }
  }
}
```

`codemode: false` exposes CMG's `execute` directly as `cmg_execute`, avoiding another
Code Mode wrapper around the executor being measured. `protocol: legacy` uses one
initialize handshake without a discovery-probe process. Use two sessions from the
same directory and shared OpenCode service, with read-only document tasks. The
agents should discover tool schemas and choose their own JavaScript calls.

[`scripts/observe-gateway.ts`](scripts/observe-gateway.ts) forwards the original
stdio bytes to one real gateway child. Its append-only local JSONL records contain
observer/gateway PIDs, request IDs, OpenCode session IDs, in-flight request counts,
elapsed request times, execution outcome categories, and tool-call counts. It does
not record submitted code, tool arguments, document bodies, or credentials. The
session IDs are correlation values, not authentication. Start with a fresh log or
separate runs by their `started` records and PIDs.

Two distinct session IDs under one gateway PID establish process sharing;
overlapping request/response intervals establish concurrent gateway requests.
These counts include transport and cleanup time, not just active VM time. The
observer parses frame copies and writes logs synchronously, so timings include
diagnostic overhead. It is an opt-in integration probe, not production telemetry.

#### Observed agent integration

Two actual OpenCode sessions using the configured default
`opencode-go/gemini-4-argon-contributor` independently researched different sections
of the same known Notion page. Both discovered schemas, generated their own
JavaScript, retrieved the document, and produced research summaries. The observer
recorded two distinct session IDs under one gateway PID, using capacity 8 and the
64-MiB guest heap from `examples/notion.json`.

The initial research produced nine successful executions and thirteen tool calls,
with no capacity, timeout, or infrastructure failures. Requests took 49–857 ms.
Despite simultaneous agent launches, these execution intervals did not overlap:
model reasoning and generation time dominated their scheduling. Separate six-pass
search/fetch consistency checks also passed all twelve combined checks but did not
overlap (8.37 and 6.49 seconds of gateway request time).

Extending each session's check to twelve sequential passes produced two overlapping
execution requests for **8.343 seconds** under that same gateway PID. Both returned
twelve successful identity/marker checks, with 24 tool calls each and request times
of 13.53 and 20.50 seconds. No delays or retry logic were added. The difference in
duration is not isolated to concurrency; the slower run included several roughly
2.5-second upstream searches.

Across research and both follow-ups, all **13 executions** succeeded, with **85
observed tool calls** and no capacity rejections. Disconnecting the temporary MCP
connection produced gateway exit code 0, no signal, and zero pending requests. The
temporary OpenCode configuration was removed. This establishes two-session sharing
and live overlap, not saturation capacity, long-duration stability, or multi-process
sharing. The session transcripts contain research results; the observer log contains
only correlation and outcome metadata.

Both agents initially returned broad discovery results that OpenCode replaced with
a saved-output notice showing zero inline lines. Both recovered by projecting tool
names and short descriptions before inspecting individual schemas. This was a
client display limit, not a CMG execution failure. It identifies discovery-output
usability as a concrete follow-up; raising guest memory would not address it.

#### Four-session follow-up

Four fresh OpenCode sessions using the same model independently researched
ownership, design, testing, and migration sections of the known page. All four
session IDs appeared under one gateway PID at capacity 8. Each agent completed its
research, but the initial phase produced **19 successful executions and four
explicit limit failures** across 23 requests and 174 observed tool calls:

- Two scripts described the full catalog sequentially and returned both search
  results and descriptions, exceeding the 256-KiB final-output limit.
- Two scripts described many tools using `Promise.all`, exceeding ten outstanding
  calls within their individual executions. Discovery helpers count as tool calls.
- All four recovered with narrower calls. OpenCode also spilled five successful
  responses to saved files instead of displaying their single large JSON lines.

These were per-execution discovery-strategy failures, not rejection by the
eight-execution admission limit. Natural research traffic reached two simultaneous
sessions for only 107 ms; request latency across successes and failures was
39–3,323 ms, with p50 78 ms and p95 1,452 ms. The timing includes local discovery
and immediate failures, so it is not a live-provider latency percentile.

Each session then generated a single execution containing twelve sequential
search/fetch passes, without rediscovery, artificial delays, or retries. All four
requests overlapped for **10.886 seconds**, and all **48 passes** verified the
known page identity and marker. Each execution made 24 upstream calls; gateway
request times were 13.10, 15.18, 15.50, and 17.55 seconds.

The complete four-session run recorded **27 executions: 23 successes and the four
discovery limit failures**, with **270 observed tool calls**. There were no
execution-capacity rejections, timeouts, or infrastructure failures. Disconnecting
the temporary MCP server produced exit code 0, no signal, and zero pending
requests; both gateway and observer processes exited, and the temporary config was
removed. This is a finite four-way integration check at capacity 8, not a capacity
ceiling or a sustained-load measurement.

These results motivated a discovery change addressing the broad-catalog workflow:
agents duplicated schemas already returned by search, exceeded per-execution
limits, and then needed extra calls to recover. These observations do not justify
raising every limit together.

### Compact discovery

Guest `searchTools` now returns a page of short name/description previews, with no
input schemas. Five results are returned by default; `total` and `nextOffset` expose
remaining matches, and callers can change `limit` or browse by `offset`. Descriptions
collapse whitespace and truncate at 200 UTF-16 code units. `describeTool` retains the
complete description and input schema for a selected name.

Ranking prioritizes query terms in tool names before terms in descriptions, so
action queries such as `notion search fetch` favor the relevant tools over unrelated
tools whose long descriptions mention those actions. Stable ties and all matching
tools remain available. Host `ToolCatalog.search()` retains its full-metadata list;
only the guest helper changes to the page shape.

The gateway's tool description states the API and runtime contract, leaving tool
selection and composition to the agent. Contract tests cover name ranking, complete
pagination, malformed page arguments, and a large schema that stays accessible
through `describeTool` while the search preview fits a small output budget.

Four fresh OpenCode sessions then repeated the same ownership/design/testing/
migration research prompts, with the same probe-agent instructions and gateway
limits. This rerun compared compact discovery and its initial workflow guidance
against the previous behavior. It preceded the later wording-only simplification
of the tool description to the API contract.

| Observation                         | Previous four-session research | Compact-discovery rerun |
| ----------------------------------- | ------------------------------ | ----------------------- |
| Completed research tasks            | 4/4                            | 4/4                     |
| Execution requests                  | 23                             | 21                      |
| Successful executions               | 19                             | 21                      |
| Discovery limit failures            | 4                              | 0                       |
| Observed tool calls                 | 174                            | 40                      |
| Discovery-only client output spills | 2                              | 0                       |

All four session IDs shared one gateway PID; peak overlapping requests reached
three. Successful request times were 27–1,281 ms (p50 412 ms, p95 1,198 ms). The pure
five-result search report was 1,365 characters in two sessions. Some agents still
described several previews rather than selecting exactly two, but none described
the whole catalog or exceeded the existing call/output limits.

Five successful responses containing document data still spilled to client-managed
files, and agents narrowed their subsequent returns. Compact discovery addresses
catalog overhead, not arbitrary document-return size. These finite runs show an
improvement for these tasks, not a deterministic agent-behavior guarantee or a
controlled latency benchmark. The updated Notion smoke example and a focused local
concurrency diagnostic also passed. The observed gateway exited with code 0, no
signal, and zero pending requests; its temporary OpenCode configuration was removed.

### Contract-only prompt validation

Four fresh sessions repeated the same research tasks against commit `c475844`,
using the shorter API-contract description and the same probe-agent instructions.
All four completed their research and reported successful page identity/marker
checks. One gateway PID served all four session IDs, with peak overlap of two
requests. All **20 executions succeeded**, with **51 observed tool calls**, no
discovery-limit failures, and no timeouts or infrastructure errors. Request latency
was 48–3,508 ms (p50 455 ms, p95 2,941 ms).

Compared with the prescriptive-description run, execution requests changed from
21 to 20 and tool calls from 40 to 51. Agents exercised more choice: one requested
ten search previews, and others described the default five. Discovery-only output
spills stayed at zero; document-related spills stayed at five. This small comparison
supports retaining the shorter prompt, without establishing a general latency or
efficiency advantage. The gateway exited naturally with code 0, no signal, and no
pending requests; its temporary OpenCode configuration was removed.

#### Why large document returns disappeared from the preview (historical response format)

At measurement time, CMG's MCP response emitted the complete report both as
`structuredContent` and as one compact JSON text line. In the inspected local
OpenCode source (`bcf23b6775`), `packages/core/src/tool-output.ts` defaults to 2,000
lines / 50 KiB and retains only whole lines within that byte budget. A first line
larger than 51,200 bytes produces a saved-output notice with **zero inline lines**.
OpenCode's direct MCP adapter uses text content for model-visible content; the
parallel structured result does not replace that preview.

Five saved document responses from the preceding discovery run were 51,266–66,894
bytes, each on one line. Three were only **66 bytes over** the client threshold.
An offline pretty-print check still left the document marker outside the retained
preview in four of five cases: the embedded document remained one long JSON-string
line. Simply adding JSON indentation would expose some envelope/search metadata,
but would not reliably expose the document.

The smallest targeted follow-up is client-side: retain a UTF-8-safe partial line
when the next line exceeds the remaining preview budget, keep the full saved output,
and clearly mark the partial preview. Increasing CMG's guest limits does not address
this boundary. No response-format or client-runtime change was made during this
investigation. The probe agent permits only `cmg_execute`, so it could not use
OpenCode's file-read tool to recover saved output; ordinary agents with that tool
can attempt another recovery path. The read-enabled follow-up below tests that
path. Repeated fetch counts depend on tool availability as well as formatting.

#### Saved-output reads

A follow-up enabled `read` and external-directory access specifically for
OpenCode's saved-output directory, keeping the same model, research prompts,
gateway configuration, and ten-step budget. The probe's instructions were adjusted
to allow saved-output reads rather than requiring exclusive use of `cmg_execute`.

Three original sessions completed. The design session stalled before its first
assistant response and made no gateway calls; it was interrupted and rerun in a
fresh session, which completed. The cause of that pre-tool stall was not identified.
The four completed tasks shared one gateway PID but their requests did not overlap,
so this is a recovery-path observation rather than a four-way load comparison.

| Observation               | Without `read` | With `read` (including design retry) |
| ------------------------- | -------------- | ------------------------------------ |
| Completed research tasks  | 4/4            | 4/4                                  |
| Successful CMG executions | 20             | 13                                   |
| CMG execution failures    | 0              | 0                                    |
| Observed calls inside CMG | 51             | 42                                   |
| Upstream searches         | 9              | 6                                    |
| Upstream fetches          | 16             | 9                                    |
| Saved-output `read` calls | 0              | 1                                    |
| Client output spills      | 5              | 3                                    |

Only the migration agent used `read`; the others either avoided spilling or
requested narrower returns through CMG. The counts are descriptive, not a measured
causal benefit of enabling `read`: agent choices varied, and the design task ran
separately after the stall.

The migration agent successfully read a spilled result: permissions did not block
it. However, the result was a 51,266-byte single-line JSON file, and `read` returned
only the first 2,000 characters plus a line-truncation notice. The required document
marker was at character offset 11,405, outside that preview. The agent subsequently
fetched the page again through CMG and returned a smaller, parsed excerpt.

This is a second client-side boundary. In the inspected OpenCode
`packages/core/src/tool/read-filesystem.ts`, `clampLine()` shortens each line to
2,000 UTF-16 code units; `offset` and `limit` select lines, not positions within a
line. Enabling `read` alone therefore does not guarantee recovery of large compact
JSON. A partial-line display fix would improve the initial preview, but full
saved-output recovery also needs a way to access the remainder of a long line.

The gateway exited with code 0, no signal, and zero pending requests. The temporary
OpenCode configuration and analysis script were removed. No runtime changes were
made to CMG or OpenCode for this test.

## Development

For the bounded ten-minute local reliability workload and its fault/recovery
sequence, see [the reliability diagnostic](docs/reliability.md).

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
24. Per-executor concurrent execution admission (default 4), gateway configuration,
    immediate excess-request rejection, and capacity held through worker cleanup.
25. Shared-gateway concurrency diagnostics with burst/staggered local workloads,
    configurable overlapping Notion smoke workflows, and measured capacity tradeoffs.
26. Two actual OpenCode agent sessions sharing one stdio gateway, verified live
    request overlap, and an opt-in metadata-only stdio observer.
27. Compact paged discovery, name-prioritized search, selected-tool schema lookup,
    and updated agent guidance based on observed broad-catalog failures.
28. Host-only `onToolException` observer for callback exceptions that agents see as
    `Host tool failed.`; `cmg` writes them to stderr as JSON lines.
29. MCP protocol failures expose tool names, numeric codes, and messages to scripts,
    including SDK output-validation messages, while retaining original causes for
    host diagnostics and keeping error data and stacks out of guest rejections.
30. Library deadlines are unset by default and guest memory defaults to 256 MiB.
    Tool calls beyond the configured active concurrency queue in invocation order
    within the total-call budget; gateway deadlines remain 5/10 seconds.
31. Agent-facing MCP responses contain only returned values/error text, with `isError`
    only on failure. Gateway output above 40,000 UTF-8 bytes spills to private temporary
    files with head/tail previews and native-tool paths; hard output defaults to 16 MiB.
32. A pinned QuickJS SDK memory-view patch fixes async results that grow WASM memory.
    The patched SDK JavaScript ships in codemode's build, with standalone-install
    regression coverage and bundled MIT notices; WASM variants remain external.

The byte-forwarding observer now records only MCP outcomes, request/session IDs,
overlap, and timings; execution categories and call counts are no longer exposed
on the wire. In-process diagnostics validate execution reports directly on the host.

Next: continue ordinary multi-agent use and longer runs before revisiting
defaults. Additional limits remain paused. Runtime-level follow-up on the
WASM-memory reproduction remains open. Current guest limits do not bound aggregate
concurrent memory or temporary tool-response allocations.
