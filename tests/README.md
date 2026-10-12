# Testing conventions

Tests document observable contracts. A reader should be able to understand the
scenario and its expected outcome without stepping through production code.

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
`src/codemode` and `src/mcp`; process fixtures can include internal probes for busy startup
and interruption that must run outside the test runner.

The worker/local equivalence test belongs with the supervisor: it checks transport
fidelity. Public tests separately assert expected values so a shared engine bug
cannot pass solely because both paths agree.

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
- `superviseWorker` in `tests/support/workers.ts` constructs the real internal
  `WorkerExecution` class with an injected worker. It contains no supervision logic.
  Build worker requests with `startupData` and flags with `interruptFlag` rather than
  by hand, so new startup fields need one change.
- `tests/support/worker-cleanup.ts` holds termination gates and listener assertions.
  It imports `bun:test`, so process fixtures must not import it.

## Running and checking stability

Run commands from the package root:

```sh
bun run check
bun run example
bun test ./tests/unit
bun test ./tests/component
bun test ./tests/integration
```

After changing test organization or timing-sensitive behavior, use a reproducible
randomized run and focused repetition:

```sh
bun test ./tests --seed 73129
bun test ./tests/component/worker-cancellation.test.ts --rerun-each 3
```

Investigate failures rather than adding retries. Tests with shared-module spies
must not run concurrently in the same runtime. The default suite runs every layer.

## References

- [Google: behavior, clarity, and DAMP tests](https://abseil.io/resources/swe-book/html/ch12.html)
- [Google: real dependencies and focused test doubles](https://abseil.io/resources/swe-book/html/ch13.html)
- [Fowler: asynchronous ordering and nondeterminism](https://martinfowler.com/articles/nonDeterminism.html)
- [Bun: writing and parameterizing tests](https://bun.com/docs/test/writing-tests)
