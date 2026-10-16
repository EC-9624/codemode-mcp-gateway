# Codemode test ownership

The tests specify public behaviors by subject. Import subjects through
`@codemode-mcp-gateway/codemode`, keep Arrange → Act → Assert visible, and give each independent
event sequence its own test. Support code owns mechanics, not scenario decisions.

## Public subjects

| File                               | Primary contracts                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `sandbox.test.ts`                  | Function bodies, JSON conversion, exceptions, promises/thenables, recovery                  |
| `sandbox-options.test.ts`          | Default and per-run tool snapshots, fixed options, fresh and overlapping executions         |
| `sandbox-capacity.test.ts`         | Per-executor execution admission, cleanup-held capacity, cancellation and failure recovery  |
| `sandbox-tools.test.ts`            | Host invocation, public/private failures, draining, argument/result conversion              |
| `sandbox-reports.test.ts`          | Invocation order, metadata-only summaries, complete guest responses, interruption snapshots |
| `sandbox-boundary.test.ts`         | Host API exclusion, lexical isolation, wrapper validation, mutable built-ins, exact names   |
| `sandbox-limits.test.ts`           | Constructor validation, source admission, real memory/stack behavior                        |
| `sandbox-output.test.ts`           | Serialized JSON/raw-message byte limits and output interruption                             |
| `sandbox-budget.test.ts`           | Total/concurrent admission, slot reuse, discovery/validation charging                       |
| `sandbox-cancellation.test.ts`     | Cancellation, signal privacy, late callbacks, registration races                            |
| `sandbox-deadlines.test.ts`        | Guest/total deadlines, error conversion, host work/waits, responsiveness                    |
| `sandbox-worker.test.ts`           | Public infrastructure rejection, malformed worker traffic, independent host admission       |
| `sandbox-lifecycle-faults.test.ts` | Public outcome selection, reentrant events, held cleanup, cleanup failure                   |
| `catalog.test.ts`                  | Metadata, search/ranking, snapshots, descriptive schemas, discovery composition             |
| `tools.test.ts`                    | Standard Schema validation, transforms, metadata export, cancellation, composition          |

`sandbox-worker` and `sandbox-lifecycle-faults` call `CodeExecutor.execute`, not
`WorkerExecution.run`. `captureWorker` observes the worker dependency without
changing the production API. Tests inject messages, hold termination, or fail
listener registration only where real scheduling cannot produce the fault reliably.
The expected result and event sequence remain in each test.

## Retained private observations

These supplement public contracts only where the public boundary hides the required
observation. They do not define another suite of ordinary execution semantics.

| File                               | Why the public interface cannot establish this observation                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox-ownership.test.ts`        | The worker terminates before VM/runtime/scope/handle liveness can be inspected; partial setup and disposal causes remain worker-local |
| `sandbox-faults.test.ts`           | Native dispatcher/settlement allocation and no-access-after-disposal faults occur inside the worker                                   |
| `sandbox-transport-faults.test.ts` | Worker-local MessagePort listeners and partial registration need direct resource observation                                          |
| `sandbox-admission-faults.test.ts` | Independent guest admission must be proved without the parent enforcing the same budget first                                         |
| `worker-boundary.test.ts`          | The public executor always constructs valid startup data and hides worker-local parser/dispatcher faults and stalled startup          |

No production exports or configuration hooks were added for these tests. Existing
cross-file exports serve production callers. A passing recovery test is not evidence
that a native resource was disposed, so those assertions are retained explicitly.

## Specification-first migration map

| Previous scenario                                                                                               | Surviving owner                                                                                            |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Supervisor malformed-response, early-exit, messageerror, duplicate completion, reply-post failure, replay tests | `sandbox-worker`, through public execute and the actual Worker dependency                                  |
| Supervisor setup failure with worker errors during registration/termination                                     | Two separate `sandbox-lifecycle-faults` scenarios                                                          |
| Supervisor cancellation, timeout, successful completion, and cleanup-failure snapshots                          | `sandbox-lifecycle-faults`, with explicit expected reports and scoped termination gates                    |
| Supervisor time elapsed before observation                                                                      | `sandbox-lifecycle-faults`: “counts listener setup time against the total deadline”                        |
| Direct parent total/concurrent admission and cleanup failure                                                    | `sandbox-worker`: independent-host-admission cases; injected messages bypass guest enforcement             |
| Raw worker startup, missing entry, parser/dispatcher faults, decoder exception, real crash with late callback   | `worker-boundary`; retains actual boundary and privacy observations                                        |
| Stalled-startup cancellation/deadline and interrupt flag                                                        | `worker-boundary`; process fixtures additionally prove real exit                                           |
| Shared execution instance and mixed ordinary-value assertions                                                   | `sandbox`: local setup, named return/thenable variations, separate ordinary-object and primitive scenarios |
| Error-conversion timeout in basic execution                                                                     | `sandbox-deadlines`: message-getter and toJSON cases                                                       |
| Host-global exclusion in basic execution                                                                        | `sandbox-boundary`: “does not expose host APIs to guest code”                                              |
| Search ranking mixed with name-only, blank, and unmatched queries                                               | Separate `catalog` cases with the original expected ranking retained                                       |
| Independent catalogs mixed with inherited definitions                                                           | Separate `catalog` independence and inherited-entry cases                                                  |
| Discovery unknown-name failure mixed with empty search                                                          | Separate `catalog` callback cases                                                                          |
| Omitted native arguments accepted and rejected in one script                                                    | `tools`: accepted undefined through execute; object-required rejection through validateTool                |
| Validation, transformation, metadata, and privacy                                                               | `tools`, grouped by public definition/validation/composition responsibility                                |

Other public contract suites remain their original owners; their valid behavior
assertions were not removed just to change suite size. Former layered helper suites
remain represented by these public owners and the explicit resource observations.

## Process and distribution

`process-lifecycle.test.ts` owns real child exit after execution, deadline, and
cancellation. Its internal shared-flag/startup probes distinguish interruption
from merely asking a worker to terminate. `fixtures/packaged-codemode.ts` is run by
root packed-consumer verification, not imported into ordinary tests.

```sh
bun run --cwd packages/codemode check
bun run --cwd packages/codemode test --randomize --seed 73129
bun run --cwd packages/codemode test --test-name-pattern 'CodeExecutor outcome ownership' --rerun-each 3
```

Shared dependency spies must not run concurrently in one runtime. All gates and
spies are scoped; subprocess watchdogs bound stuck-worker regressions.
