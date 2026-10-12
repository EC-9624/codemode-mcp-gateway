# Testing conventions

Tests document observable contracts. A reader should be able to understand the
scenario and its expected outcome without stepping through production code.

Each package owns its `tests/`, support helpers, fixtures, and `test`/`check` commands:

| Package             | Owned contracts                                                                       |
| ------------------- | ------------------------------------------------------------------------------------- |
| `packages/codemode` | Tools, discovery, guest execution, VM/worker ownership, limits, cancellation, reports |
| `packages/mcp`      | Catalog adaptation, schemas, injected executors, upstream lifecycle                   |
| `packages/gateway`  | Configuration, composition, CLI, end-to-end workflow, stdio/HTTP shutdown             |

Root scripts coordinate package commands and packed-install verification. There
is no root test suite. Tests can import another package's public API, but not its
internals or test files. Small mechanical helpers may be repeated locally rather
than creating a shared test-framework package.

## Where a test belongs

| Directory      | Contract under test                                                      | Examples                                                                          |
| -------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `unit/`        | Isolated logic without a VM or worker                                    | Protocol decoding, catalog search/metadata, discovery argument validation         |
| `component/`   | A specific subsystem with real dependencies and targeted fault injection | QuickJS disposal, bridge settlement, supervisor races, listener lifetime          |
| `integration/` | Public sandbox behavior and process lifecycle                            | Guest semantics, host tools, discovery, cancellation, deadlines, process exit     |
| `support/`     | Shared test mechanics                                                    | Local bridge adapter, worker constructors, disposal assertions, rejection capture |
| `fixtures/`    | Executable worker/process scenarios                                      | Crashes, stalled startup, interruption probes                                     |

Classify by the contract being checked, not by counting imported modules or mocks.
Component tests may finish with a public recovery check. Integration scenarios use
`@cmg/codemode` and `@cmg/mcp`; codemode's process fixtures can include internal probes for busy startup
and interruption that must run outside the test runner.

## Minimal, critical coverage

Prefer public contract tests with explicit expected results, not comparisons
between two implementations that could share the same bug. Give each behavior
one primary owner; another layer needs a test only when crossing that boundary
adds a distinct failure risk.

- Test shared validation rules once with representative input classes. Keep
  constructor/worker wiring checks and each field's advertised bounds, not a
  cross-product of every bad number and every option.
- Keep report assertions next to the scenario they describe: include empty calls
  in the basic execution/pre-abort tests, and guest values plus retained public
  responses in serialization/privacy tests.
- MCP tests own strict execute inputs and response projection, using an injected
  executor with plain callbacks and counters rather than constructing a gateway.
  Injected reports test adapter behavior, not end-to-end execution. Gateway tests
  use real QuickJS for execution and recovery, and own discovery injection, policy
  composition, cancellation propagation, and process lifecycle.
- Internal tests justify themselves through disposal, ordering, no retry,
  malformed-boundary handling, or private-error protection. Do not pin native
  callback counts or the exact number of owned handles as an optimization target.
- Keep genuine failure boundaries: busy computation and microtasks, stalled
  startup and host waits, independent parent/worker admission, late completions,
  partial setup, cleanup failures, real child exit, and HTTP session deletion.

Before removing a test, identify the surviving test that catches the same
regression. Strengthen that test if necessary. Reducing reported test counts by
packing unrelated cases into large tests is not a coverage reduction strategy.
No fixed test-count or line-coverage percentage replaces these contracts.

## Readable tests

- Name the expected behavior and relevant condition: `returns cancelled when the
  caller aborts before startup`.
- Keep one behavior per test. Multiple assertions can establish that behavior.
- Separate setup, action, and assertions with blank lines. Use short comments for
  non-obvious ordering; ordinary tests do not need section-label comments.
- Keep inputs and expected outcomes visible. Prefer explicit expected data over
  computing expectations using the same algorithm as the implementation.
- Use `test.each` or loops that register separately named tests for data variations.
  Give different event sequences separate tests rather than branching on a scenario flag.
- Keep helpers small and mechanical. A little repeated setup is clearer than a
  configurable test framework or deeply nested shared hooks.
- Use specific matchers. Type-narrowing guards are fine after asserting the expected
  variant; an unexpected variant must not silently skip every assertion.

```ts
test("returns cancelled when the caller aborts before startup", async () => {
  const signal = AbortSignal.abort();

  const sandbox = new CodemodeSandbox();
  const report = await sandbox.execute("return 42;", { signal });

  expect(report).toEqual({
    result: {
      ok: false,
      error: { kind: "cancelled", message: "Execution cancelled." },
    },
    calls: [],
  });
});
```

## Dependencies, ordering, and cleanup

- Prefer real QuickJS, message channels, and workers. Use narrowly scoped spies
  when an infrastructure failure cannot be triggered reliably otherwise.
- Assert resource state and required ordering. Call counts are useful for contracts
  such as no duplicate dispatch or no retry after VM failure.
- Use explicit start/release promises to establish async ordering. Keep real timers
  where elapsed time, deadline enforcement, or event-loop responsiveness is the contract.
- A gate still needs a bounded test timeout. Potentially stuck worker scenarios run
  in subprocesses with outer watchdogs.
- Scope spies and resource cleanup with `using`, `await using`, or `try/finally`.
  Release pending gates on failure paths. Avoid shared mutable test state.
- Use `rejectionOf` for arbitrary rejection reasons and `executionErrorOf` when
  asserting the public `SandboxExecutionError` contract and inspecting its cause/calls.
- `installLocalToolBridge` is a test adapter over the real guest bridge. It provides
  visibility into handles and original errors; worker/cancellation guarantees must
  be checked through the supervisor or public execution path.
- `superviseWorker` in `packages/codemode/tests/support/workers.ts` constructs the real internal
  `WorkerExecution` class with an injected worker. It contains no supervision logic.
  Build worker requests with `startupData` and flags with `interruptFlag` rather than
  by hand, so new startup fields need one change.
- `packages/codemode/tests/support/worker-cleanup.ts` holds termination gates and listener assertions.
  It imports `bun:test`, so process fixtures must not import it.

## Running and checking stability

Run commands from the workspace root. Package suites and their source subprocesses
select the development condition; they do not require an overall test run or a
prior build. Compiled exports are separately checked in isolated installed consumers:

```sh
bun run check
bun run example
bun run --cwd packages/codemode test
bun run --cwd packages/mcp test
bun run --cwd packages/gateway test
bun run --cwd packages/gateway check
bun --conditions=development test ./packages/codemode/tests/component
bun run verify:packages
```

After changing test organization or timing-sensitive behavior, use a reproducible
randomized run and focused repetition:

```sh
bun run --cwd packages/codemode test --randomize --seed 73129
bun --conditions=development test ./packages/codemode/tests/component/worker-cancellation.test.ts --rerun-each 3
```

Investigate failures rather than adding retries. Tests with shared-module spies
must not run concurrently in the same runtime. The default suite runs every layer.

`scripts/verify-packages.ts` packs built artifacts and checks isolated installations.
The standalone fixture installs codemode without MCP; the composition fixture
checks the MCP adapter and executable CLI. Both typecheck against emitted `.d.ts`
files and use real workers. These fixtures are not imported by ordinary tests.

## References

- [Google: behavior, clarity, and DAMP tests](https://abseil.io/resources/swe-book/html/ch12.html)
- [Google: real dependencies and focused test doubles](https://abseil.io/resources/swe-book/html/ch13.html)
- [Fowler: asynchronous ordering and nondeterminism](https://martinfowler.com/articles/nonDeterminism.html)
- [Bun: writing and parameterizing tests](https://bun.com/docs/test/writing-tests)
