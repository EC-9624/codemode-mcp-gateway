# Bounded long-running reliability diagnostic

```sh
bun run baseline:reliability --smoke
bun run baseline:reliability
```

The smoke command runs one six-phase sequence in seconds. The default runs three
sequences over approximately ten minutes, including warmup and idle/shutdown
sampling. Both fail on semantic mismatches and unexpected request failures. They
use source export conditions and actual QuickJS workers. No external service,
credentials, forced GC, or model calls are involved.

## Workload and ownership

One `createServer` gateway/executor and one agent MCP client remain alive for the
entire run. A local controllable MCP upstream is connected with the SDK's
`InMemoryTransport`; both sides exercise real MCP initialization, discovery,
validation, dispatch, cancellation, and response handling. This is simulated
read-oriented traffic, not a stdio/HTTP network or live-provider soak.

Warmup searches the tool catalog, describes `fetch`, and executes a document
workflow. Each workflow searches for two known documents, fetches both in
parallel, and returns checked IDs, lengths, and first/last characters. Search
waits 120 ms; fetch waits 180 ms and returns 64 KiB of text per document. Reports
are checked for metadata-only call summaries and expected call ordering.

Each of 18 slots lasts 30 seconds. It runs one ordinary workflow, pauses 200 ms,
then overlaps three workflows. A different fault/recovery sequence follows:

1. Cancel an in-flight cooperative callback through the agent MCP request.
2. Cancel an uncooperative callback; verify worker exit and successful recovery
   **before** allowing the upstream callback to finish late.
3. Return a recognized MCP `isError` response; verify that it stays ordinary data,
   then successfully run another workflow.
4. Close the upstream during a held call; check a generic private-boundary script
   failure, another failure while disconnected, and successful local discovery.
   Explicitly connect the **same upstream Client** to a new local server with the
   same catalog, then verify recovery through the existing gateway. There is no
   automatic reconnect, retry, or catalog refresh.
5. Hold all four existing execution slots, require an immediate fifth-request
   capacity rejection without a worker, release the four, then verify recovery.
6. Let the two-second guest deadline expire during an uncooperative callback;
   check timeout/interrupted-call semantics and recovery before releasing it.

This repeats three times. Remaining slot time is idle rather than more traffic.
After a final 30-second idle, close the gateway with another uncooperative request
in flight. Require the agent's SDK connection-closed error, upstream abort, and
worker cleanup before `close()` completes, then release the late callback and
close the upstream. Sample another 30 seconds before natural process exit. The
parent watchdog fails and kills only its diagnostic child after 660 seconds
(60 seconds for smoke); lock-wait time is outside that watchdog.

Expected full-run outcomes, including warmup and shutdown: 130 requests, with 111
completed, six caller-cancelled, nine expected failed reports (six disconnected
tool failures and three timeouts), three capacity rejections, and one shutdown
disconnect. Recognized public upstream failures are successful executions because
the guest explicitly checks their error data. The upstream must receive exactly
91 searches, 182 fetches, 25 waits, and three public-failure calls. No rejected
request is retried.

## Evidence and limitations

JSONL records contain environment, per-request results/timings, one-second RSS
samples, quiescent checkpoints, counters, shutdown timing, and child exit status.
RSS includes the gateway, both MCP clients, the local upstream, worker/WASM
allocations, and diagnostic overhead. It is not isolated gateway memory or a
guaranteed peak. No RSS threshold asserts correctness or establishes a leak.

`scripts/reliability-workers.ts` temporarily wraps the real `Worker.prototype.on`
dependency in the isolated diagnostic process. It observes each worker and its
actual exit event. At quiescent checkpoints it verifies `threadId === -1` and no
remaining message, messageerror, error, or exit listeners, then drops its strong
references. The wrapper is restored on scope exit. This dependency probe is needed
because the public gateway does not expose worker lifetime events; it does not
replace workers, dispatch, or termination. Exit/listener evidence does **not**
observe individual QuickJS handle disposal or prove native memory reclamation.

Cancellation rejects the agent's MCP promise, so the cancelled execution report is
not delivered to this client. Cancelled-request counts describe that client
observation, supported by upstream abort and worker cleanup evidence. Shutdown
disconnects are counted separately. `reportedCalls` counts only delivered reports;
it includes an attempted tool call while disconnected. Upstream invocation counts
come from actual handlers. Upstream `active`/`peakActive` counters specifically
count held `wait` handlers; they do not count delayed search/fetch callbacks.

SDK 2.3.1 wraps caller aborts as `SdkErrorCode.RequestTimeout`. The diagnostic
identifies cancellation by its explicitly triggered controller and matching reason,
then requires upstream abort and worker exit; it does not classify cancellation
from that SDK error code alone.

The diagnostic retains counters and bounded live gates, not a history of reports
or document bodies. Logs are streamed. It tests one runtime/environment, a modest
intermittent arrival rate, four-slot overlap, and controlled faults. It does not
establish production capacity, multi-hour stability, real provider reconnection,
OAuth recovery, network failure behavior, or isolation of Bun/WASM memory growth.

## Coordinated validation

For the October 2026 three-slice investigation, these commands were serialized
across worktrees by a temporary shared kernel-lock wrapper. To reproduce the
diagnostic independently, run them without other resource-heavy workloads:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run baseline:reliability --smoke
bun run baseline:reliability
bun run check
bun run example
```

The entire default diagnostic, including its child, warmup, and idle/shutdown
sampling, ran within one lock acquisition during that investigation.

## Observed run: 2026-10-15

Source base: `c47584455ee82f361100a0ee013b770f7aaf5ba0`, plus the diagnostic changes
in this slice. Environment: Apple M3 Pro, macOS arm64 / Darwin 25.6.0, Bun 1.4.2
(`744846f844374847c902b5e7fd59b4342a51ef99`), QuickJS SDK 0.32.0, MCP SDK 2.3.1.
GC remained automatic. The main checkout's latest README findings were consulted
read-only; implementation and validation stayed in the reliability worktree.

One full run started at **06:38:47.003 UTC**, measured **600.507 seconds**, and
exited naturally after **600.626 seconds** including child startup/exit overhead.
The lock covered checks, example, and the complete measurement from 06:38:08.970
to 06:48:47.500 UTC. No second long run was needed.

| Request outcome                        | Count |
| -------------------------------------- | ----: |
| Successful, semantically checked       |   111 |
| Caller-cancelled                       |     6 |
| Expected disconnected-tool failures    |     6 |
| Expected guest deadlines               |     3 |
| Expected execution-capacity rejections |     3 |
| Shutdown connection closed             |     1 |
| Unexpected failures                    |     0 |
| Total                                  |   130 |

- All 18 traffic cycles and three explicit upstream reconnections passed. One
  gateway/executor served the complete run; the upstream had four connections.
- Actual upstream calls: **301** (91 search, 182 fetch, 25 wait, three public
  failures). Delivered reports contained 302 call summaries, including three
  interrupted timeout calls. The accounting differs for discovery helpers,
  calls attempted while disconnected, and cancelled/closed client requests.
- All **127 admitted workers** were observed exiting and checked for removed
  listeners and `threadId === -1`. There were zero active workers at every
  quiescent checkpoint. Peak worker overlap was four; peak outstanding agent
  requests was five during the deliberate admission rejection.
- Upstream handlers observed **13 aborts and ten uncooperative late returns**.
  Recovery succeeded while the cancelled/deadline callbacks were still held.
  No held callbacks or agent requests remained at shutdown.
- Gateway close took **2.706 ms** with an active request. Worker exit was observed
  before close returned, while the uncooperative upstream callback remained held.
  Releasing it and closing all connections left the child able to exit with
  **code 0, no signal, and no watchdog termination**.
- Ordinary document requests took 350–393 ms; three-way overlapping document
  requests took 352–465 ms. Capacity rejections took 0.30–0.65 ms, and deliberately
  expired requests took approximately 2,038 ms. These are descriptive observations
  of this fixture, including its delays and diagnostic overhead.

### Memory observations

There were 599 periodic one-second samples plus phase checkpoints. Values are
process-wide RSS in MiB; the initial sample follows connection/catalog setup.

| Checkpoint                           | Elapsed seconds | RSS MiB |
| ------------------------------------ | --------------: | ------: |
| Before first worker                  |           0.037 |    80.7 |
| Warmup complete                      |           0.453 |   127.1 |
| Six cycles / 44 exited workers       |         153.792 |   257.5 |
| Twelve cycles / 85 exited workers    |         333.875 |   296.7 |
| Eighteen cycles / 126 exited workers |         513.790 |   324.8 |
| Start of final pre-shutdown idle     |         540.455 |   324.3 |
| After 30 seconds idle                |         570.456 |   324.1 |
| Shutdown / 127 exited workers        |         570.503 |   324.8 |
| After 30 seconds post-shutdown idle  |         600.507 |   324.4 |
| Highest sampled RSS                  |                 |   325.2 |

RSS continued rising over this bounded workload despite all observed worker exits.
Neither 30-second idle materially reduced it. These measurements do not identify
the retained allocations, establish an application leak, or prove that memory
will plateau. The separate Bun/WASM investigation owns runtime attribution. No
CMG lifecycle defect was demonstrated, so no production code or limits changed.

### Exact verification and retained artifacts

Raw artifacts were retained outside the repository in the investigation's local
`cmg-slices` temporary directory; they are not distributed with the package.

- `reliability-install.log`: locked `bun install --frozen-lockfile --ignore-scripts`
  succeeded.
- `reliability-preflight*.log`: locked preparation used `bunx oxfmt --write` on the
  changed files, `bun run typecheck`, and targeted `bunx oxlint --deny-warnings`
  (including `--fix` for required statement padding). An initial wrong SDK error
  enum was caught by typechecking; the first executing smoke exposed the SDK's
  cancellation wrapper. These were corrected in the diagnostic, not production
  code. All failed preflight logs remain available.
- `reliability-smoke.log`: locked `bun run baseline:reliability --smoke` passed in
  11.063 seconds: 46 requests, all expected outcomes, 45 observed exits/cleanup
  checks, and natural exit code zero.
- `reliability-validation-lock.log`: one invocation of
  `python3 "$LOCK" zsh -c 'bun run check && bun run example && bun run baseline:reliability'`
  with each command's output redirected to the following separate files.
- `reliability-check.log`: **passed** builds, typechecks, lint, formatting,
  **555 tests** (352 codemode, 65 MCP, 138 gateway; zero failures), and isolated
  packed-consumer declaration/worker/cancellation/MCP/CLI verification.
- `reliability-example.log`: **passed** `bun run example`, including its intended
  success, script-error, limit, timeout, cancellation, and recovery examples.
- `reliability-soak.jsonl` / `reliability-soak.stderr`: the **single full run**,
  including environment, all counters/samples, shutdown timing, and natural exit.
  Stderr contains only Bun's command banner.
- `reliability-result.md`: concise slice handoff recorded before integration.

No unit-test suite was added: the new behavior is the opt-in, assertion-bearing
diagnostic itself. Existing lifecycle/failure suites and required distribution
checks were run in full. The CLI, HTTP, and installed-package checks in that suite
remain short checks; this ten-minute measurement specifically covers the local
in-memory MCP composition described above.
