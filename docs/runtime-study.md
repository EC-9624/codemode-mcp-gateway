# Worker memory and host-runtime comparison

**Conclusion: upgrade to Bun 1.4.3 rather than migrate the gateway to Node to solve
this memory issue.** In the 10,000-operation scalar soak, its kernel physical
footprint decreased over the last 5,000 operations and reached 28.36 MiB after idle,
versus 193.03 MiB on Bun 1.4.2. Node ended at 186.44 MiB in this workload, despite
showing lower OS RSS. Node's better four-way throughput remains a separate tradeoff.

Investigation started 2026-10-16 on macOS arm64, from `9ce90ed`.
The earlier [WASM allocation investigation](wasm-memory.md) remains historical evidence;
this study measures the real executor and the cost of potential mitigations.

## Questions and scope

1. Does disabling Bun's WASM fast-memory path stop continued growth in CMG, not just
   in a standalone `WebAssembly.Memory` reproduction?
2. Does Bun 1.4.3 change the result relative to the pinned Bun 1.4.2?
3. What changes make the execution/MCP libraries run on installed Node 24.15.0,
   and how do memory, latency, and concurrent throughput compare?

This is a runtime study, not a full Node gateway migration. The gateway still uses
Bun's credential service, HTTP listener, file APIs, and browser launcher. No actual
credentials, providers, or model calls are used.

## Code changes being measured

- The guest job pump uses `node:timers/promises`'s `scheduler.wait(0)` instead of
  `Bun.sleep(0)`, retaining its timer/I/O yield while allowing Node execution.
- Two MCP adapter dependency deep imports include `.js`, as required by Node ESM.
- `.bun-version`, package runtime declarations, and current usage documentation now
  select Bun 1.4.3. Historical measurements are not rewritten. No global runtime is
  upgraded; the compatible existing Bun type declarations remain pinned separately.
- `scripts/runtime-contract.ts` runs selected execution and MCP contracts using
  compiled public exports under either runtime. Bun remains the full-suite runner.
- `scripts/runtime-comparison.ts` measures fresh-worker controls, scalar execution,
  1-MiB tool responses, guest arithmetic, microtask yielding, and an in-memory MCP
  discovery/schema/tool workflow. It validates every result and call summary.
- `scripts/runtime-matrix.ts` runs children serially, rotates host order between
  repetitions, enforces a SIGKILL watchdog, and saves each child's JSONL and stderr.

No worker pool, VM reuse, relaxed validation, global Bun upgrade, engine replacement,
or different sandbox limits are involved. Every host runs the same compiled code.

## Method

- Fresh process per host/scenario/repetition; ten warmup operations.
- Controls: empty workers and 16-MiB WASM memories, with observed replies and natural exits.
- Direct controls load the same small TypeScript fixture in each host; Node's native
  type-strip loader is therefore included in their startup cost. The actual executor
  and its workers use compiled JavaScript, not that loader.
- Executor workers retain normal CMG termination and cleanup; controls' exit counts
  do not purport to observe executor-internal QuickJS disposal.
- Memory sequences: 3,000 measured operations, snapshots each 100; scalar repeats
  three times, WASM repeats twice, empty worker once.
- Performance: 200 operations per repetition, except 100 microtask operations;
  three repetitions. Tool and MCP workloads also run four concurrent executions.
- Default sandbox policy except explicit equal 5-second guest / 10-second total
  budgets and scenario-specific admission equal to measured concurrency.
- Automatic GC; **OS RSS from `/bin/ps -o rss= -p PID`**, converted from KiB to bytes,
  is the common cross-runtime measure. Bun 1.4.3 changed its JS RSS API on macOS to
  report physical footprint; comparing that directly with 1.4.2/Node RSS would be wrong.
  Runtime-reported memory/5-ms peaks and Bun allocator commitment are supplemental,
  distinctly labeled data, not interchangeable RSS measurements.
- Common OS RSS is sampled between batches and after a one-second final idle. Whole-process RSS includes
  host, workers, WASM, client/provider, and instrumentation; peaks can be missed.
- No other study benchmarks run concurrently. This is a normal developer machine,
  not an isolated performance host. Repeated, rotated runs reduce but cannot remove
  background activity, caching, or thermal effects.

An initial matrix was stopped during its empty-worker controls when the RSS API
change was discovered. Those partial results are excluded. The restarted matrix
uses the common OS probe for every child; throughput includes periodic observation
overhead, while per-operation latencies do not include between-batch observations.

The candidate executable is a local, checksum-verified Bun 1.4.3 release download,
not a replacement for the user's installed runtime. SHA-256:
`80afd4c069b46a6fa8f3ec520bebc750a7843e4a8d5b9583d29ad436c00a3403`.

## Reproduction

Build first; omit the `development` export condition for all comparison commands:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
node scripts/runtime-contract.ts
bun scripts/runtime-contract.ts
bun scripts/runtime-matrix.ts --directory /absolute/path/to/results \
  --bun /absolute/path/to/bun-1.4.2 --node /absolute/path/to/node-24.15.0 \
  --candidate /absolute/path/to/bun-1.4.3
```

`--smoke` selects eight operations per scenario and one repetition; it checks the
matrix, not sustained memory behavior. Result directories must be new: per-run
files are exclusively created to prevent overwriting previous evidence.

## Upstream state

GitHub inspected during this study: latest published release is Bun 1.4.3;
[PR #41512](https://github.com/oven-sh/bun/pull/41512) remains open/unmerged.
Release publication is not evidence that a particular fix is present; the actual
binary's revisions and measurements determine the comparison.

The downloaded binary reports mimalloc
`92ef6587c57b262f6e6abf513f7776a2f8d12aeb`, versus 1.4.2's
`6a64e1ba7f5b2130d4efccb67ec87fd0003f0f6a`. Its pinned
[`src/os.c`](https://github.com/oven-sh/mimalloc/blob/92ef6587c57b262f6e6abf513f7776a2f8d12aeb/src/os.c)
contains the explicit `if (sze > 1*MI_GiB) return NULL` address-hint guard and the
explanation of retained WASM page-map submaps. That establishes inclusion of the
relevant source change, not the absence of all other retention.

The [1.4.3 release notes](https://bun.com/blog/bun-v1.4.3) also disclose the macOS
RSS-definition change and GC/native-purge improvements. This is why the study
records a common OS measure rather than attributing every reported-memory drop
to one allocator patch.

## Node migration boundary

The portable proof exercises public execution/MCP APIs, guest-job yielding,
cancellation, deadlines, admission, recovery, private host globals, and real MCP
request/response composition. It is not a substitute for a full Node test suite.

The remaining gateway migration is concentrated at these boundaries:

| Boundary                    | Current dependency                                          | Work needed without narrowing behavior                                                                              |
| --------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Configuration/version reads | `Bun.file().json()` in `config.ts` and `main.ts`            | `node:fs/promises` reads with the same parsing and public/private error contract                                    |
| Credential persistence      | Static `secrets` import from `bun` in `auth/credentials.ts` | A maintained OS-keychain adapter; preserve service identity, locking, failure categories, and no plaintext fallback |
| OAuth callback listener     | `Bun.serve` in `auth/loopback.ts`                           | A Node HTTP listener preserving Host/path/state/issuer checks, port reuse, cancellation and awaited shutdown        |
| Browser launch              | `Bun.spawn` in `auth/login.ts`                              | Node subprocess equivalent with the same launcher fallback and private-error behavior                               |
| Executable/distribution     | Bun CLI shebang and package engine declarations             | Node version contract, correct executable launch, isolated packed-consumer verification                             |
| Test coverage               | `bun:test`, Bun HTTP/process fixtures                       | Node-owned process/HTTP/OAuth/worker lifecycle tests; do not merely rewrite imports and claim parity                |

An injected `CredentialStore` already provides a useful seam, but simply making it
mandatory on Node would remove the standalone gateway's built-in OAuth behavior.
Likewise, a Bun subprocess for secrets would retain a Bun runtime dependency rather
than complete the migration. Neither workaround is presented as full Node support.

The boundary is observable, not just a migration estimate: running
`node packages/gateway/dist/cli.js --help` fails before argument handling with
`ERR_MODULE_NOT_FOUND` for `bun`, imported by the credential adapter. No credential
operation was attempted. Library benchmark success must not be described as a
working standalone Node gateway.

Worker pooling or VM reuse could amortize startup, but would change ownership,
cleanup, interruption, and fresh-execution guarantees. They are not needed to test
the allocator hypothesis and are intentionally excluded.

## Verification

Both Bun 1.4.2 and the downloaded Bun 1.4.3 passed `bun run check`: **638 tests**, build,
typecheck, lint, formatting, and isolated packed-consumer verification per runtime.
The selected compiled-export contract also passed on Node 24.15.0. The matrix's
smoke phase passed all hosts/workloads before the long runs.

After updating the project pin and recording the results, the full Bun 1.4.3 check
passed again with 638 tests and packed-consumer verification. Both runnable examples
passed on 1.4.3, and the selected compiled-export contract passed again on Node 24
and Bun 1.4.3. No global runtime installation was changed.

## Completed 96-run matrix

All 96 children exited zero, with no stderr, forced kills, or result mismatches:
**85,200 measured operations**, plus 960 warmup operations. Direct controls observed
every expected worker reply and natural exit. Machine-readable observations are
preserved in [the measurement artifact](measurements/runtime-matrix-2026-10-16.json).

### Growth between operations 1,000 and 3,000

MiB; medians of **per-run changes**, not differences between independently selected
medians. WASM has two repetitions, scalar has three. The Bun commitment counter is
allocator bookkeeping, not a cross-runtime physical-memory measurement.

| Host                            | WASM OS RSS growth | WASM commitment growth | Scalar OS RSS growth | Scalar commitment growth |
| ------------------------------- | -----------------: | ---------------------: | -------------------: | -----------------------: |
| Bun 1.4.2                       |              34.44 |                 125.81 |                45.13 |                   141.56 |
| Bun 1.4.2, fast memory disabled |               3.23 |                   0.75 |                30.98 |                     2.75 |
| Bun 1.4.3                       |               2.76 |                   6.00 |                30.50 |                     0.00 |
| Node 24.15.0                    |              14.86 |                    N/A |                20.36 |                      N/A |

The dominant allocator-commitment trend disappears in 1.4.3 and with fast memory
disabled. It is **not** correct to claim that either makes actual executor RSS flat
by operation 3,000. The one-second scalar idle OS RSS medians are 291.52 / 290.17 /
275.50 / 141.05 MiB in the table's host order. These RSS values include reclaimable
resident pages; the later soak separately measures kernel physical footprint.

### Sequential latency

Milliseconds, median of each repetition's p50; three repetitions. Scalar uses
3,000 operations per repetition; other workloads use 200, except 100 microtask
operations. These are descriptive samples, not production percentile estimates.

| Workload                            | Bun 1.4.2 | 1.4.2, fast memory disabled | Bun 1.4.3 | Node 24.15.0 |
| ----------------------------------- | --------: | --------------------------: | --------: | -----------: |
| Scalar return                       |     23.09 |                       22.08 |     20.87 |        35.43 |
| 1-MiB tool response, return length  |     40.21 |                       43.09 |     35.54 |        57.36 |
| Guest arithmetic                    |     55.84 |                       59.05 |     52.53 |        71.35 |
| 1,000 guest microtask continuations |     61.97 |                       65.46 |     61.07 |        56.29 |
| MCP discovery/schema/read           |     33.21 |                       34.79 |     34.30 |        45.71 |

### Four-way throughput

Validated executions/second, median of three fresh-process repetitions, 200
operations each. Each execution still owns a fresh worker. Admission is set to
four for every host; workloads do not retry or change concurrency semantics.

| Workload                  | Bun 1.4.2 | 1.4.2, fast memory disabled | Bun 1.4.3 | Node 24.15.0 |
| ------------------------- | --------: | --------------------------: | --------: | -----------: |
| 1-MiB tool response       |     35.07 |                       36.53 |     33.82 |        56.84 |
| MCP discovery/schema/read |     56.86 |                       53.06 |     58.82 |        73.94 |

Node is not uniformly slower: it pays more sequential startup cost but has about
68% higher four-way tool throughput and 26% higher four-way MCP throughput than
Bun 1.4.3 in these workloads. The mechanisms behind that scaling difference were
not isolated. In-memory MCP does not establish live-provider/HTTP/OAuth capacity.

Disabling fast memory on 1.4.2 is also not free: sequential tool, arithmetic, and
microtask p50s are about 7%, 6%, and 6% higher here, while other rows vary in either
direction. A diagnostic flag is not preferable to a validated fixed release merely
because it removes one standalone reproduction's trend.

## Longer soak and conclusion

Four additional serial scalar runs completed **10,000 measured operations each**,
plus ten warmups. All returned correct results and exited zero with empty stderr.
They add a common macOS `footprint` probe at quiescent checkpoints to distinguish
resident/reclaimable pages from kernel-charged physical footprint. Data is preserved
in [the soak artifact](measurements/runtime-soak-2026-10-16.json).

This is one longer run per host, not three more performance repetitions. Each uses
1,000-operation batches, natural GC, and the same compiled executor. Observations
are sequential, not atomic; external probes and the final idle give background
purging time to operate. Per-operation latencies exclude those probe calls.

MiB, using kernel physical-footprint counters from the **same external tool**:

| Host                            | Footprint at 5,000 | At 10,000 | After 1-second idle | Whole-run peak | OS RSS after idle |
| ------------------------------- | -----------------: | --------: | ------------------: | -------------: | ----------------: |
| Bun 1.4.2                       |             113.73 |    193.37 |              193.03 |         193.89 |            545.14 |
| Bun 1.4.2, fast memory disabled |              31.35 |     30.35 |               29.89 |          64.11 |            385.89 |
| Bun 1.4.3                       |              63.17 |     55.14 |               28.36 |          92.80 |            290.30 |
| Node 24.15.0                    |             128.69 |    186.76 |              186.44 |         193.71 |            221.59 |

During operations 5,000–10,000:

- Bun 1.4.2 adds **79.64 MiB physical footprint** and **313.38 MiB allocator
  commitment**. Approximately 64 KiB commitment per cycle matches the page-map
  retention hypothesis; its JS heap is only about 2.55 MiB at completion.
- Fast-memory-disabled 1.4.2 adds no allocator commitment and its physical footprint
  decreases by 1.00 MiB. The fallback is effective for the identified issue.
- Bun 1.4.3's footprint decreases by 8.03 MiB; commitment increases by 15.50 MiB,
  not zero. The dominant per-cycle retention is absent, but it would be wrong to
  claim every native allocation is flat or that the process has a proven hard bound.
- Node's footprint increases by 58.07 MiB. That does not prove a Node leak; allocator
  retention, caches, and VM behavior were not isolated. It does establish that this
  migration is not a better memory fix in the tested sequence.

The divergence between OS RSS and physical footprint matters: Bun 1.4.3 still has
290.30 MiB resident after idle, yet only 28.36 MiB kernel-charged footprint. Node's
lower 221.59 MiB RSS coexists with a much higher 186.44 MiB footprint. Resident,
reclaimable/purged pages must not be treated as an equal amount of live, charged
memory. The conclusion does not depend on comparing Bun's changed JS RSS API.

### Decision

1. **Use Bun 1.4.3.** It includes the relevant allocator source fix, passes the full
   application/distribution checks, removes the demonstrated physical-growth trend
   in this soak, and improves several sequential workloads without changing
   execution ownership or sandbox limits.
2. **Do not add a worker pool or remove worker isolation for this issue.** There is
   an effective runtime-level remedy; those changes carry unrelated semantics.
3. **If temporarily constrained to 1.4.2**, the experimental
   `BUN_JSC_useWasmFastMemory=false` flag is a measured fallback, not a recommended
   permanent application default. Its performance varies by workload.
4. **Keep Node as a viable future performance option, not the memory remedy.** The
   two-library portability changes are small and validated, and four-way throughput
   is genuinely better here. A complete standalone migration still owes the native
   credential, callback HTTP, CLI, distribution, and test work listed above.

These conclusions cover one Apple M3 Pro/macOS environment and finite workloads.
They do not establish indefinite stability, Linux behavior, production percentiles,
or live-provider OAuth/HTTP performance. No real credentials or provider calls were
used. Overall evidence covers **125,200 measured operations** and 1,000 warmups.

This addresses the Bun allocator-retention finding, not the separate audited
QuickJS 0.32.0 context-pointer/disposal fault when WASM memory grows during queued
jobs. The SDK is unchanged here; fixing that defect remains separate work. Passing
these bounded workloads must not be described as resolving every sandbox issue.

Reproduce a longer run with each chosen executable, serially (use a separate output
file per host; add the environment flag only for the 1.4.2 fallback):

```sh
/absolute/path/to/runtime scripts/runtime-comparison.ts \
  --scenario scalar --runs 10000 --batch 1000 --concurrency 1 --footprint \
  > /absolute/path/to/host-soak.jsonl
```

`--footprint` requires macOS's `/usr/bin/footprint`; neither OS observer changes
global configuration or requires a privileged operation for these owned processes.
