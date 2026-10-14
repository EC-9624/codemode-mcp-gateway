# Testing conventions

Test meaningful behavior through its intended interface, using real code and
small, explicit, readable scenarios. Tests specify **what** a module guarantees.

Each package owns its `tests/`, support helpers, fixtures, and `test`/`check` commands:

| Package             | Test through                                                  | Owns                                                                                |
| ------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `packages/codemode` | `CodemodeSandbox`, `ToolCatalog`, public tool APIs            | JavaScript and host-call semantics, discovery, limits, cancellation, reports        |
| `packages/mcp`      | `createMcpCatalog`, `createCodemodeServer`                    | Schema adaptation, dispatch, response projection, borrowed-client/executor lifetime |
| `packages/gateway`  | Configuration, `createServer`, `login`, `logout`, serving/CLI | Composition, authorization, fixed policy, upstream/process lifetime                 |

Root scripts coordinate package commands and packed-install verification. There
is no root test suite. Tests can import another package's public API, but not its
internals or test files. Small mechanical helpers may be repeated locally rather
than creating a shared test-framework package.

## The module is the unit

Import contract subjects from `@cmg/codemode`, `@cmg/mcp`, or
`codemode-mcp-gateway`. Exercise their real implementation and internal collaborators.
Changing a private parser, bridge, or transition helper should not require rewriting
the behavioral specification.

- Organize `tests/*.test.ts` by public subject. Split a large subject by a clear
  contract, such as cancellation or limits, rather than by implementation files.
- Do not use `unit/`, `component/`, or `integration/` subdirectories.
- Put shared mechanical setup in `tests/support/` and executable fixtures in
  `tests/fixtures/`. Keep the scenario and expected result in the test itself.
- Do not expose private functions just to test them. An internal cross-file export
  is not a reason to give that function an independent test suite.
- A small private-boundary probe is justified when an important resource-ownership
  or infrastructure guarantee cannot reasonably be observed publicly. Explain that
  limitation near the probe and avoid repeating ordinary public behavior there.
- Real child exit, stdio wiring, and packed installation still require dedicated
  process/distribution checks. Keep them small; they do not need to repeat the
  sandbox's JavaScript semantics.

## Minimal, critical coverage

Give each public contract one primary owner and an explicit expected result.
Another boundary needs a test only when crossing it adds a distinct failure risk.
Two implementations agreeing does not establish that either one is correct.

- Use representative input classes and field-specific limits through the owning
  interface. Avoid repeating one shared validation rule across every caller and
  every possible combination of invalid fields.
- Keep report assertions next to the scenario they describe: include empty calls
  in the basic execution/pre-abort tests, and guest values plus retained public
  responses in serialization/privacy tests.
- MCP tests own strict execute inputs and response projection, using an injected
  executor with plain callbacks and counters rather than constructing a gateway.
  Injected reports test adapter behavior, not end-to-end execution. Gateway tests
  use real QuickJS for execution and recovery, and own discovery injection, policy
  composition, cancellation propagation, and process lifecycle.
- Observe behavior: preserved state, rejected input, resource disposal, ordering,
  privacy, and no retry. Do not pin private call sequences or exact native handle
  counts as optimization targets.
- Keep genuine failure boundaries: busy computation and microtasks, stalled
  startup and host waits, independent parent/worker admission, late completions,
  partial setup, cleanup failures, real child exit, and HTTP session deletion.

Before removing a behavioral test, identify its surviving contract owner and migrate
any unique meaningful assertion. Strengthen an existing scenario before adding more
cases. Private implementation mechanics need not become public requirements just
because an old test asserted them. Do not lower the count by hiding unrelated cases
inside an omnibus test. Neither a test-count target nor a coverage percentage is the goal.

## Readable tests

- Prefer DAMP over DRY: explicit meaningful data and familiar local variable names.
  Reuse boring setup; accept duplication when reuse would hide the scenario.
- Name the expected behavior and relevant condition: `returns cancelled when the
  caller aborts before startup`.
- Keep one behavior per test. Multiple assertions can establish that behavior.
- Separate setup, action, and assertions with blank lines. Use short comments for
  non-obvious ordering; ordinary tests do not need section-label comments.
- Keep inputs and expected outcomes visible. Prefer explicit expected data over
  computing expectations using the same algorithm as the implementation.
- Use `test.each` or loops that register separately named tests for data variations.
  Give different event sequences separate tests rather than branching on a scenario flag.
- Avoid generic fixture builders and deeply nested setup/action/assertion expressions.
- Use specific matchers and assertion-based narrowing when supported. An unexpected
  result variant must fail, never silently skip the meaningful assertions.

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

- Prefer real QuickJS, MCP SDK clients/transports, HTTP servers, and workers. Substitute
  external services at their boundary, not application modules. Plain injected
  executors are appropriate for the MCP adapter's projection and lifetime contracts.
- Use narrowly scoped fault injection when an important failure cannot be triggered
  reliably otherwise. It must fail only at the intended phase: a later injected
  failure must not mask incorrect recovery from the first one.
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
- Recovery is not proof of disposal. Ownership probes must observe the owned
  resource; a recorded DELETE is not proof that shutdown awaited its completion.
- Keep test-only helpers out of executable fixtures when they import `bun:test`.

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
bun run verify:packages
```

After changing test organization or timing-sensitive behavior, use a reproducible
randomized run and focused repetition:

```sh
bun run --cwd packages/codemode test --randomize --seed 73129
bun run --cwd packages/codemode test --test-name-pattern cancellation --rerun-each 3
```

Investigate failures rather than adding retries. Tests with shared-module spies
must not run concurrently in the same runtime. The default suite runs every package subject.

`scripts/verify-packages.ts` packs built artifacts and checks isolated installations.
The standalone fixture installs codemode without MCP; the composition fixture
checks the MCP adapter and executable CLI. Both typecheck against emitted `.d.ts`
files and use real workers. These fixtures are not imported by ordinary tests.

## References

- [Google: behavior, clarity, and DAMP tests](https://abseil.io/resources/swe-book/html/ch12.html)
- [Google: real dependencies and focused test doubles](https://abseil.io/resources/swe-book/html/ch13.html)
- [Fowler: asynchronous ordering and nondeterminism](https://martinfowler.com/articles/nonDeterminism.html)
- [Bun: writing and parameterizing tests](https://bun.com/docs/test/writing-tests)
