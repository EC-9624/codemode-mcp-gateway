# Managed Gateway transport soak (opt-in)

```sh
bun run baseline:gateway --smoke
bun run baseline:gateway --minutes 30
# --minutes accepts integers 30–60; no implicit long run.
```

Run serially, without other resource-heavy diagnostics. Preparation does not imply
a successful run: smoke and long-run measurements must be recorded separately.
This diagnostic does not change the historical in-memory reliability baseline or
its expected counts. No dependencies, credentials, OAuth, external services, forced
GC, or production code changes are required.

## Topology and assertions

One public `Gateway` and its executor stay alive throughout. An SDK client uses an
in-memory **agent-facing** connection; managed upstreams use a real Bun subprocess
over stdio and a real ephemeral `127.0.0.1` Streamable HTTP listener. The stdio
fixture is runnable independently and does not import test helpers.

Warmup checks qualified discovery, reads 64 KiB from each upstream, and verifies
both complete document boundaries. It also holds an HTTP call for 16 seconds,
crossing Bun's default 10-second idle timer and the SDK's 15-second SSE heartbeat;
the result must survive and no new SSE GET may be opened. This synthetic fixture
uses `idleTimeout: 30`, with 20-second execution and 25-second total deadlines.
These diagnostic settings do not alter production defaults. Every cycle repeats this workflow, holds two
separate executions (one per transport), observes both active through read-only
stats calls, then explicitly releases them and checks both results. A public MCP
tool failure is checked as ordinary error data with exactly one handler invocation.
Four rotating fault phases follow:

1. Cancel a gated stdio call; require the SDK cancellation wrapper, upstream abort,
   handler return, and zero remaining held handlers.
2. Do the same over HTTP.
3. Terminate the owned stdio child with a gated request in flight; require an error
   response, old process disappearance, automatic managed reconnection, and a new PID.
4. Expire the HTTP session; return 404 to the old session's next request, require
   an error response and automatic fresh connection.

Every phase then runs a **new** document workflow through both upstreams. Failed
scripts are never replayed. Polling repeats only observational stats/status checks,
not failed or possibly writing operations. Fixture tools are synthetic/read-only
apart from diagnostic gate release. Smoke runs all four phases. A long run uses
10-second slots (unused time idle); slow cycles can overrun a slot without increasing
concurrency. Traffic stops after the requested duration, then performs shutdown.
Warmup, final idle and shutdown are additional bounded overhead.

Exactly two large outputs (warmup/final) concatenate the real upstream documents.
The diagnostic checks the 40,000-byte inline budget, parses the native file reference,
reads all 128 KiB using `Bun.file`, and checks file/directory permissions. Only these
two paths are retained; files must remain readable until Gateway shutdown and must
then disappear with their directory. This avoids unbounded spill accumulation in
the soak; it does not add a product storage quota or TTL.

Shutdown starts with a gated HTTP execution active. It requires the SDK connection-
closed rejection, no active HTTP handlers, an observed HTTP DELETE, stdio process
disappearance, output cleanup, and balanced request-outcome counters. The supervisor
requires natural child exit with code zero and no signal. Its watchdog kills only
the diagnostic child after 90 seconds for smoke, or duration plus two minutes; a
watchdog kill is a failure, not cleanup evidence. Catastrophic kills can leave
temporary output and descendant processes; inspect the recorded PIDs if that occurs.

## Observations and limits

JSONL streams environment, controlled status transitions, compact counters,
10-second memory samples, cycle/idle checkpoints, shutdown time, and process exit.
GC remains automatic. Memory is explicitly **diagnostic-child process memory**:
Gateway, HTTP fixture, SDK and workers, but **not the stdio subprocess**. Sampled
peak RSS is not an instantaneous/whole-process-tree peak. There is no memory
threshold, leak verdict, plateau claim, or isolation of Bun/WASM allocations.
On macOS, Bun 1.4.3's `process.memoryUsage().rss` reports physical footprint,
not the OS RSS used in older-runtime comparisons. Do not compare this field directly
with the historical Bun 1.4.2 RSS observations.

Live state is bounded: counters, current sessions, at most a few pending requests,
two spill paths and current gates. Logs stream instead of retaining request history.
Connection state is observed through the public API, not inferred from memory.
Natural exit and process disappearance do not inspect individual VM handles or
worker listeners. Unlike the older diagnostic, this one uses no worker prototype
instrumentation and makes no direct worker-disposal assertion.

Not covered: agent-facing stdio/HTTP, OAuth, real providers, arbitrary network
partitions, uncooperative late callbacks, deadline/admission matrices, catalog
schema churn, write rollback/exactly-once semantics, high throughput, or multi-hour
stability. HTTP expiry is a controlled local session fault, not a socket/network
partition. Local process termination is not crash-safe descendant supervision.
The historical baseline and package tests retain their separate contracts.

## Validation status

On 2026-10-16, the coordinating session ran `bun run baseline:gateway --smoke`
on Bun 1.4.3, Apple M3 Pro, macOS arm64 / Darwin 25.6.0, against `149cf22` plus
the uncommitted diagnostic changes. The four fault phases passed in approximately
13.5 seconds: 81 requests, 76 successful completions, two expected failures, two
caller cancellations, and one shutdown disconnect. Both upstreams reconnected;
two spill files were read exactly and removed on shutdown. No active requests
remained, one final HTTP DELETE was observed, and the supervisor observed natural
exit code zero without a signal or forced kill. Request totals can vary with
read-only status polling and are observations, not fixed workload assertions.

The combined `bun run check` passed build, typechecking, lint, formatting, 656 tests,
and packed-consumer verification; `bun run example` also passed. The 30-minute run
is a separate verification step; smoke does not establish long-run stability.

### Observed 30-minute run

The same source/runtime environment then ran `bun run baseline:gateway --minutes 30`
serially, starting at 2026-10-16 00:56:12 UTC. It completed 30 minutes of slotted
traffic, with the final summary at 1,820.4 seconds including warmup/idle/shutdown.
The [compact measurement record](measurements/gateway-soak-2026-10-16.json) includes
source hashes, counters, memory checkpoints, and hashes of the externally retained
`gateway-30m.jsonl` and `gateway-30m.stderr` evidence.

| Observation                                |                Result |
| ------------------------------------------ | --------------------: |
| Completed fault/traffic cycles             |                   180 |
| Total requests                             |                 3,192 |
| Successful completions                     |                 3,011 |
| Expected controlled-disconnection failures |                    90 |
| Caller cancellations                       |                    90 |
| Shutdown disconnect                        |                     1 |
| Managed reconnects                         | 90 (45 per transport) |
| Peak requests / active at summary          |                 4 / 0 |
| Spill files verified and removed           |                     2 |
| Gateway shutdown time                      |                6.0 ms |

All cycle-end request counters balanced with zero active requests. Both upstreams
made 46 connections including initial setup. Final HTTP cancellation/return,
session DELETE, stdio disappearance, output-directory removal, and natural
supervisor-child exit passed. Exit code was zero, with no signal or watchdog kill.
The deliberate stdio-failure phases still terminate their owned upstream processes;
natural final exit is not a claim that no fault was injected.

The diagnostic child's reported physical footprint was 107.8 MiB after warmup,
133.4 MiB sampled peak, and 94.7 MiB after shutdown idle. These are scoped, finite
observations, not proof of a plateau or a hard bound, and exclude the stdio child.

Stderr contained the command banner and **one Bun HTTP idle-timeout warning**:
`Bun.serve() timed out a request after 10 seconds. Pass idleTimeout to configure.`
No assertion failed. At the time, the fixture had no explicit `idleTimeout` and
the warning's cause was not isolated. That historical measurement is unchanged.

### Slice 37: idle behavior characterized

`bun run validate:http-idle` is an opt-in raw HTTP probe, without gateway retries or
automatic SSE reconnection. On Bun 1.4.3 it checks default and explicit 30-second
idle settings separately for an SSE GET and a JSON POST held for 18 seconds.
The expected default-timeout case can print Bun's warning; this command is not
supposed to be warning-free. Each case has a 25-second watchdog, checks the result
or `ECONNRESET`, and requires a subsequent ping on the same MCP session. A pending
POST is invoked exactly once; it is never retried.

The observed default SSE GET reset after approximately 12 seconds, before its
15-second heartbeat. With an explicit 30-second idle timeout it delivered the
heartbeat at 15 seconds. The held default JSON POST emitted the same warning but
still returned its result at 18 seconds; the configured POST returned at 18 seconds
without that warning. Thus the warning does **not** by itself establish lost or
failed tool work. The original long-run warning cannot retrospectively be assigned
to an exact request from its metadata.

The SDK's installed GET implementation sends its first keepalive after 15 seconds;
`enableJsonResponse` does not disable that separate stream. Bun documents a default
10-second idle timer, including pending/streaming requests:
[server idle timeout](https://bun.com/docs/runtime/http/server#idletimeout).
The probe uses `node:http` to observe reset directly; an initial Bun `fetch` GET
probe reached its watchdog instead of exposing the reset. That client difference
was not investigated further.

Only the synthetic soak listener now has an explicit 30-second idle timeout,
longer than its heartbeat and execution deadlines. The updated smoke passed all
four phases in approximately 30.5 seconds, including the new 16-second idle check,
with no timeout warning: 80 requests, two controlled failures, two cancellations,
one shutdown disconnect, two reconnects, and two verified/deleted spills. The
gateway supervisor exited naturally with code zero and no signal or forced kill.
An initial attempt correctly hit the diagnostic's old 15-second execution deadline
during the new hold; the fixture deadlines were raised, not production defaults.
The 30-minute soak has **not** been rerun with this changed fixture.
