# Actual-agent gateway validation (opt-in)

```sh
bun run validate:models --approve-model-calls
```

This command makes **paid model-provider calls**. It is not part of `check` or
`validate:agents`. Obtain approval before running it; the flag acknowledges that
approval, not a dollar-cost cap. The model is `openai/gpt-6.1-sol-fast` and each of
four sessions is limited to 12 agent steps. Existing OpenCode provider credentials
are reused, never copied into repository files. Requires OpenCode V2 and Bun 1.4.3.

## Scope and evidence

The runner creates one temporary OpenCode Location, disables inherited MCP
entries there, and configures one observed CLI gateway and one synthetic document
upstream. It uses the existing shared service through `opencode api`, not four
standalone services. A custom primary agent permits only `cmg_execute` and native
reads of files inside this temporary Location. No shell, edits, subagents, OAuth,
Notion, or other live upstream is required. Model requests still leave the machine;
provider/model configuration and plugins remain inherited from the user's service.

Each agent independently discovers tools, inspects schemas, searches once, fetches
once, reads a saved document, and surfaces one deliberate public error. Four search
handlers rendezvous at a gate; this creates controlled overlap rather than relying
on model scheduling. The diagnostic's longer deadlines accommodate this gate and
are not changes to gateway defaults.

The document is multiline Unicode text. A fresh verification record on line 3002
is absent from the gateway's head/tail preview. The verifier compares the final
answer with the full file, and requires a completed native `read` of that path.
The separate scripted diagnostic retains its single-line Unicode checks.

Metadata-only fixture events and the existing stdio observer establish one gateway
process, four invoking session IDs, four overlapping execute requests, and exactly
four search arrivals/returns, fetches, and deliberate failures. The four public
failures must also appear on the MCP wire. No failed operation is automatically
replayed. A failed agent task fails the run rather than starting another session.

After the sessions finish, only these sessions are interrupted and only this
Location's MCP server is disconnected. The runner requires the observer's gateway
exit record to show code zero, no signal, and no pending execute requests; all saved
files and their directory must disappear. It never stops or reloads the shared
OpenCode service. This observes the gateway child, not every OpenCode resource or
individual VM handle.

JSONL stdout contains environment, session IDs, counts, and outcomes, not document
bodies or prompts. The temporary config, observer log, and fixture audit are removed
after success. On failure, they are retained at the emitted `evidence-retained`
directory for inspection; disconnect still runs. Inspect before manually removing
that owned directory. Synthetic session transcripts remain in OpenCode's normal
session store. No session history is deleted.

## Observed run: 2026-10-16

Against `4cf5806` plus the uncommitted slices 37–39, OpenCode **2.0.30**, Bun
**1.4.3**, macOS arm64:

- Four actual Sol Fast sessions passed in approximately **18.0 seconds**.
- Each used **six tools**: five gateway calls and one native read.
- One gateway process and four in-flight requests were observed.
- All four hidden verification records and actionable public errors reached final answers.
- Exactly four searches, fetches, and deliberate failures were observed; no replay.
- All four saved files were removed; gateway exit was code zero, no signal, zero pending requests.

Compact outcomes are preserved in the
[measurement summary](measurements/model-validation-2026-10-16.json).
Unnecessary local session IDs were redacted from this public copy; outcomes,
counts, and executed-source hashes were not changed. Earlier Git revisions can
still contain those IDs; this redaction does not rewrite history.
Repository verification also passed `bun run check` (656 tests and installed-consumer
checks), `bun run example`, and `bun run verify:packages:clean`.

An earlier batch of four sessions completed the tasks, but its verifier failed:
the parser treated provider metadata on a text part as tool state. Its temporary
metadata was removed by the earlier cleanup logic, so it does **not** establish
the complete shutdown assertions. Existing transcripts were inspected without
replaying requests; the user then approved the corrected batch above. In total,
eight actual sessions were used across the two batches. The parser now validates
state only for tool parts and preserves failed-run evidence.

This is one bounded synthetic-task run with real model agents, not live-upstream,
ordinary-use, throughput, multi-hour, or production-stability evidence. Gate-induced
overlap is not a claim that independent ordinary agent requests naturally saturate
the gateway. Provider billing was not independently audited.
