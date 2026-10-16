# Integrated agent-experience diagnostic

Run from the repository root with **Bun 1.4.3** and existing dependencies:

```sh
bun run validate:agents > agent-validation.jsonl
```

This is a deterministic local diagnostic, not an LLM evaluation. Four independent
**scripted workflows**, not actual language-model agents, share one MCP client
connection to the real Gateway CLI over stdio. The CLI starts one synthetic local
MCP document upstream. No live provider, credentials, extra model, or dependency
is needed. It uses source exports, not an installed or packed executable.

## Observable contracts

- The external tool catalog exposes only `execute`; each workflow discovers and
  describes the named upstream tools through guest code.
- Four search calls enter an explicit upstream arrival gate before any can return.
  Each returns its own document marker and an observed peak of four active
  searches. Launching four promises alone is not accepted as overlap evidence.
- Each workflow fetches its own large, single-line Unicode document once. Execute
  returns one text block, without structured content. The bounded preview retains
  both markers and intact Unicode, plus native-filesystem retrieval guidance.
- The diagnostic reads each distinct saved path with `Bun.file`, compares the
  complete text exactly against its deterministic expected document, and logs only
  sizes and outcomes. It does not replay a fetch or use guest code to read files.
- Each workflow receives an actionable synthetic public error. A final upstream
  audit requires exactly four searches, four fetches, and four deliberate failures,
  proving these operation scripts were not replayed. Only startup discovery polls.
- Closing CLI stdin requests natural EOF shutdown. Success requires exit code zero,
  no signal or forced kill, upstream exit observation and absence, and deletion of
  all observed saved files and their temporary directories. The SDK does not own
  subprocess termination. A 60-second overall watchdog and a 10-second shutdown
  watchdog make forced termination a failure, never a clean shutdown.

JSONL stdout contains environment, compact request sizes/timings, retrieval
outcomes, overlap/call counts, shutdown, and a final result. It contains no document
bodies or saved-output paths. Request events establish transport/outcome checks;
subsequent workflow and final events establish semantic checks. A nonzero exit or
missing final `complete`/`passed` event means the diagnostic did not pass. Keep the
redirected evidence only if wanted; it is not automatically deleted.

## Observed local run

On 2026-10-16, the parent ran the diagnostic on Bun 1.4.3, macOS arm64, against
`149cf22` plus the uncommitted diagnostic changes. All four workflows passed.
The upstream gate observed four overlapping searches, with exactly four searches,
four document fetches, and four deliberate public failures. Each saved document
was read back exactly; the previews were 39,998 UTF-8 bytes and retained both markers.
EOF shutdown exited with code zero, without a signal or forced kill; all four
saved files and their output directory were removed. This is scripted local
integration evidence, not an actual-agent or live-provider run.

## Scope and limitations

This composes public paths already covered by focused tests; it does not duplicate
their fault-injection, permissions, protocol-version, cancellation, or resource-limit
matrices. It does not measure model reasoning, planning quality, authentication,
remote network reliability, throughput, or production readiness. Timings are local
diagnostic observations, not a benchmark. The explicit gate proves overlapping
upstream search waits, not simultaneous CPU execution or overlap at every step.

Public errors are deliberately authored fixture messages, not a claim that arbitrary
private exceptions are exposed. The native filesystem reader is the local diagnostic
host, not an LLM-connected filesystem tool. Exact output comparisons and upstream
counts cover this run only; they do not establish general exactly-once semantics.
On failure, cleanup still requests EOF and may force-kill owned children; it does
not turn a failed run into success. Failure records omit assertion messages because
assertion diagnostics could otherwise include full document bodies.
