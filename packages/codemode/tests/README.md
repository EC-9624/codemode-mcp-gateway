# Codemode test ownership

The unit is the public module, including its real collaborators. Import supported
subjects from `@cmg/codemode`; keep explicit inputs and expected outcomes in each
scenario. There are no unit/component/integration layers. `support/` holds mechanics
and `fixtures/` holds executable workers and consumers.

## Public subjects

| File                           | Primary contracts                                                                |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `sandbox.test.ts`              | Function bodies, JSON conversion, exceptions, promises/thenables, recovery       |
| `sandbox-options.test.ts`      | Construction snapshots, fixed options, fresh and overlapping executions          |
| `sandbox-tools.test.ts`        | Host invocation, public/private failures, draining, argument/result conversion   |
| `sandbox-reports.test.ts`      | Invocation order, detached retained responses, interruption snapshots            |
| `sandbox-boundary.test.ts`     | Lexical isolation, wrapper validation, mutable built-ins, exact tool names       |
| `sandbox-limits.test.ts`       | Constructor validation, source admission, real memory/stack behavior             |
| `sandbox-output.test.ts`       | Serialized JSON/raw-message byte limits and output interruption                  |
| `sandbox-budget.test.ts`       | Total/concurrent admission, slot reuse, discovery/validation charging            |
| `sandbox-cancellation.test.ts` | Public cancellation, signal privacy, late callbacks, registration races          |
| `sandbox-deadlines.test.ts`    | Guest/total deadlines, host work, waiting, event-loop responsiveness             |
| `catalog.test.ts`              | Metadata, lookup/ranking, snapshots, descriptive schemas, discovery composition  |
| `tools.test.ts`                | Native Standard Schema validation, transformation, metadata export, cancellation |

`process-lifecycle.test.ts` owns three real child-process checks: ordinary exit,
busy-worker deadline interruption, and cancellation. The installed-only
`fixtures/packaged-codemode.ts` remains owned by root packed-consumer verification.

## Deliberate private exceptions

Public execution terminates its worker and deliberately hides implementation handles
and private worker causes. These files supplement public contracts only where that
boundary prevents the required observation; they are not a second semantics suite.

| File                               | Observation requiring the private boundary                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox-ownership.test.ts`        | Actual VM/runtime/scope/handle disposal; partial setup; original and suppressed causes; prelude-only fault phases                |
| `sandbox-faults.test.ts`           | Inaccessible native dispatcher/settlement faults; no retry; no access to disposed handles; terminal failure while guest jobs run |
| `sandbox-transport-faults.test.ts` | Worker-local MessagePort listener lifetime, transport failure, and partial registration with real channels                       |
| `sandbox-admission-faults.test.ts` | Different parent/worker budgets prove independent enforcement; cleanup failure preserves admission reason                        |
| `sandbox-worker.test.ts`           | Malformed trusted-worker traffic, startup/crash faults, listener cleanup, controlled cross-worker errors                         |
| `sandbox-lifecycle-faults.test.ts` | Deterministically reentrant worker events, held termination, stalled startup, and cleanup failure after outcome selection        |

The two abort-registration probes still invoke the public sandbox. A scoped spy on
the supplied signal is necessary to create partial registration and its race.
The worker suite also verifies that its infrastructure assertion rejects a _fulfilled_
Error; otherwise the fault probes could silently accept success. Opaque promise-valued
rejection reasons are exercised by the public pre-aborted native-tool test.

## Migration and consolidation map

Old paths below refer to the former layered suite. The named test is the surviving
owner; meaningful assertions were moved before the redundant case was removed.

| Former coverage                                                                           | Surviving owner                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit/limits`: positive-integer helper and wiring matrices                                | `sandbox-limits`: “rejects a %s limit before reading tool bindings”, field endpoint/overflow cases, and null optional deadline                                                                    |
| `unit/protocol`: valid argument/result JSON, absent/null distinction                      | `sandbox-reports`: “retains undefined distinctly from null”; `sandbox-tools`: “keeps JSON text distinct from the string value it encodes” and conversion scenarios                                |
| `unit/protocol`: exact names and complete public failures                                 | `sandbox-boundary`: “preserves exact catalog names across guest dispatch without prototype or string collisions” and “delivers complete public failure text despite guest-global mutations”       |
| `unit/protocol`: failure-field projection                                                 | `sandbox-reports`: “retains only public failure fields even when the guest catches the failure”                                                                                                   |
| `unit/protocol`: startup, reply, and request validity                                     | `sandbox-worker`: actual startup rejection cases, “rejects a reply with %s before guest recovery”, and “rejects %s messages without host dispatch”                                                |
| `unit/protocol`: shared interrupt storage                                                 | `process-lifecycle` shared-flag-only probe, plus stalled-startup ownership assertions                                                                                                             |
| `unit/rejection`: original identity and promise assimilation                              | `tools`: “pre-aborted calls do not run the validator or the handler”; original-cause ownership probes                                                                                             |
| `unit/rejection`: fulfilled Error false positive                                          | `sandbox-worker`: “the infrastructure assertion rejects fulfilled Error values”                                                                                                                   |
| `unit/defined-tool` and `integration/validated-tools`: repeated validation and transforms | `tools`: “rejects invalid input before implementation, retains the failure, and lets the guest recover”; “discovery describes input while the handler receives asynchronously transformed output” |
| `defined-tool`: internal `callTool` privacy test                                          | `tools`: “keeps unexpected async validator exceptions private”, now through public execution and its full report                                                                                  |
| `integration/discovery`: snapshots and isolated catalogs                                  | `catalog`: “snapshots callbacks and descriptive fields without invoking them”; “keeps separate catalogs and ignores inherited definition entries”                                                 |
| `integration/discovery`: lookup/schema/invocation workflow                                | `catalog`: “discovers descriptive schema metadata and invokes the selected named tool”; it also establishes that manually supplied schema metadata does not validate arguments                    |
| `integration/tools`: basic async success and uncaught fixture validation                  | `sandbox-tools`: “continues executing tools after a validation failure”                                                                                                                           |
| `integration/tools`: concurrent start                                                     | `sandbox-reports`: “records responses in invocation order even when replies finish in reverse order”; the first callback cannot finish before the second starts                                   |
| `integration/tools`: BigInt host conversion                                               | `sandbox-reports`: “retains the conversion failure response rather than an unserializable host value”                                                                                             |
| `integration/execution-report`: separate unawaited-call report case                       | `sandbox-tools`: “waits for unawaited calls before reporting success”, now asserting the full retained call                                                                                       |
| `integration/tool-transport`: private lexical names                                       | `sandbox-boundary`: “does not put raw callbacks or codec helpers in the user function's scope”, extended to dispatcher/resolver names and dynamic lookup                                          |
| `integration/tool-transport`: main-thread conversion                                      | `sandbox-reports`: “serializes once on the main thread and retains detached public responses”                                                                                                     |
| `integration/sandbox`: standalone script error and replaced stringify                     | `sandbox`: “continues executing after a script failure”; `sandbox-boundary`: “keeps codecs working after global JSON, Promise, and TypeError are replaced”                                        |
| `integration/cancellation`: guest-timeout and script-error tool signals                   | `sandbox-reports`: pending-call timeout and script-throw scenarios now assert the tool signal; the latter releases late work and checks recovery                                                  |
| `component/vm`: fresh state, memory failure/recovery, ordinary disposal                   | `sandbox-options`: fresh execution scenario; `sandbox-limits`: “can catch guest allocation failure and continue in the same execution”; `sandbox-ownership`: actual resource-disposal cases       |
| `component/engine`: repeated output/prelude disposal variants                             | `sandbox-ownership`: representative output rejection and prelude compilation/factory failures; public output/memory/stack cases retain policy semantics                                           |
| `component/guest-bridge`: SDK-method and dispatcher-path permutations                     | `sandbox-faults`: settlement allocation/failure, guest catch, resumed loop, and error-conversion probes preserve no retry, original cause, and actual disposal                                    |
| `component/guest-bridge`: malformed reply permutations                                    | `sandbox-worker`: real worker malformed JSON, unknown ID, missing result, and duplicate-reply scenarios                                                                                           |
| `component/tool-call-limits`: limit during error conversion                               | `sandbox-budget`: “preserves admission failure triggered by guest error conversion”, through public execution                                                                                     |
| `component/worker-tools`: late timeout response                                           | `sandbox-deadlines`: late-response total deadline; public timeout recovery and report cases                                                                                                       |
| `component/worker-cancellation`: signal privacy and late results                          | `sandbox-cancellation`: cooperative signals and late rejection; `sandbox-reports`: late success is not converted or retained                                                                      |
| `component/worker-cancellation`: callback/toJSON cancellation                             | `sandbox-cancellation`: synchronous callback dispatch and response-conversion cancellation scenarios                                                                                              |
| `component/worker-cancellation`: pre-aborted owner and registration races                 | `sandbox-cancellation`: pre-aborted public execution and cancellation during listener registration, including partial-registration failure                                                        |
| `component/worker-cancellation`: worker crash abort                                       | `sandbox-worker`: “observes late callback rejection after a real worker crash”, including tool-signal assertion                                                                                   |
| `component/worker-cancellation` and `worker-deadline`: late events during cleanup         | `sandbox-worker`: “keeps completion fixed when cancellation and deadline expiry arrive during termination”; `sandbox-lifecycle-faults`: cancellation-fixed and stalled-startup deadline cases     |
| `component/worker-deadline`: repeated late message tags                                   | `sandbox-lifecycle-faults`: “keeps the timeout interruption reason when cancellation arrives after deadline selection”, with a blocked timer and an expired-clock completion                      |
| `component/worker-deadline`: callback/conversion budget exhaustion                        | `sandbox-deadlines`: separate synchronous-callback and JSON-conversion scenarios through public execution                                                                                         |
| `component/call-outcomes`: synchronous callback cancellation                              | `sandbox-cancellation`: “records dispatch before a callback synchronously cancels execution”                                                                                                      |
| Repeated cancellation/deadline cleanup failure cases                                      | `sandbox-lifecycle-faults`: cancellation snapshot and output-limit/timeout snapshot cases; `sandbox-worker` separately retains immediate termination rejection                                    |

The old protocol suite enumerated many equivalent malformed primitives and envelope
field permutations. These private mechanics are intentionally replaced by representative
rejection scenarios at their real owners, not copied into a new matrix or treated as
separate public features. Successful protocol variants are exercised by the public
execution, budget, output, privacy, and report scenarios. Pure numeric policy is tested
once through construction, with each option's advertised range checked separately.

## Running

From the workspace root:

```sh
bun run --cwd packages/codemode check
bun run --cwd packages/codemode test --randomize --seed 73129
bun --conditions=development test ./packages/codemode/tests/sandbox-lifecycle-faults.test.ts --rerun-each 3
```

Do not run shared-module fault spies concurrently in one runtime. Real timers belong
to deadline/responsiveness scenarios; explicit gates establish lifecycle ordering.
