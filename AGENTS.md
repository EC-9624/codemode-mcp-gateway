# codemode-mcp-gateway

A code-mode sandbox built from first principles in explainable slices toward
production readiness. Pi and Executor are design references, not runtime
dependencies. Learning shapes delivery, not the final scope.

## Scope

- Start with synchronous QuickJS execution, then add an async host-call bridge,
  worker isolation, and finally MCP integration.
- Keep each milestone small, runnable, and explained in the README.
- Bun is the only supported host runtime for now; Node compatibility is not an
  acceptance requirement.
- Simplify implementation without silently narrowing supported behavior or
  removing its tests.
- Do not add hosting, OAuth, persistence, or evaluation infrastructure without
  a concrete request.

## Guiding Principle

Make states, failures, and ownership explicit. Keep the implementation simple.

## General Style

- Use strict TypeScript. Classes own sandbox configuration and per-execution
  lifetimes; use plain functions for supporting logic. Do not introduce Effect.
- Organize reusable packages under `packages/codemode/` and `packages/mcp/`, each
  with a `src/index.ts` public entry point, its own types, and a package README.
  Codemode runtime details stay internal to `packages/codemode/src/runtime/`.
  MCP imports only codemode's public API; codemode never imports MCP or its SDK.
  `packages/gateway/` owns composition, engine selection, configuration, and transports,
  with a programmatic `src/index.ts` and a thin `src/cli.ts` exposing `cmg`.
  Importing the programmatic entry must not start the CLI or install process listeners.
  The MCP server borrows an executor rather than constructing a concrete sandbox.
- Published package imports use the export map; runtime deep imports are unsupported.
  Internal relative imports use explicit `.ts` paths; TypeScript rewrites them for
  compiled ESM. Repository source runs use the `development` export condition;
  packed consumers use `dist/`.
- Keep logic together unless extraction improves composition, reuse, or clarity.
- Do not extract single-use helpers preemptively.
- Extract helpers when they name a real domain concept, isolate a complex
  boundary, or materially simplify the caller.
- Keep supporting helpers close to the code they support, usually below the
  main export.
- Prefer existing patterns over new abstractions.
- Prefer short names that are clear in context; add qualifiers only to distinguish
  real responsibilities or ownership. More names and longer names are not inherently clearer.
- Prefer Bun APIs when they fit the task.
- Do not introduce dependencies for problems that existing tools solve simply.

## Types and Domain Modeling

- Never introduce `any`, non-null assertions, or unsafe type assertions.
- Accept `unknown` at genuinely untyped boundaries and validate before domain work.
- Generic sandbox arguments, results, and thrown values may remain `unknown`
  until the responsible domain boundary validates them.
- Prefer inference for local values.
- Add annotations when required for public contracts, useful narrowing, or clarity.
- Prefer type aliases for unions and domain values; use interfaces when they
  provide a concrete benefit.
- Use discriminated unions for meaningful alternatives and expected failures.
- Avoid loosely related optional fields when a union expresses valid states.
- Prefer `satisfies` for contract checking and `as const` for literal preservation.
- A safety comment does not make an unsafe assertion acceptable.
- Keep a primary domain type and its operations together.
- A type and matching namespace-style value, such as `ToolResult`, are appropriate
  when they improve discoverability. Do not force this pattern onto every module.

## Variables and Expressions

- Prefer `const`. Use `let` only for genuinely evolving state or narrow throwing
  dependency boundaries that require assignment before subsequent work.
- Inline trivial, single-use expressions when doing so preserves readability.
- Keep named values when they explain a domain concept, boundary, or ownership.
- Never inline owned VM handles in a way that obscures or loses disposal.
- Avoid unnecessary destructuring. Prefer dot notation when it preserves context.
- Do not remove useful names merely to reduce variable count.

## Control Flow

- Prefer guard clauses and early returns.
- Avoid `else` when the preceding branch returns.
- Use simple ternaries for choosing values; avoid nested ternaries.
- Prefer `map`, `filter`, and `flatMap` for data transformations.
- Use type predicates when filtering requires explicit downstream narrowing.
- Prefer loops for resource management, ordered side effects, and VM operations.
- Do not force imperative work into array transformations.
- Preserve callback ordering, indexes, sparse-array behavior, and side effects
  when changing an iteration strategy.

## Imports

- Prefer named imports.
- Do not alias imports or use namespace/star imports.
- When a module exports its own namespace-style value, import that value by name.
- Mark type-only imports explicitly.
- Use dynamic imports for expensive, branch-specific dependencies when justified.
- Place lazy imports inside the narrowest scope that needs them.
- Destructure dynamic import bindings near the beginning of that scope.
- Avoid inline import chains that obscure control flow.
- Do not make imports dynamic without a concrete loading or startup benefit.

## Error Handling

- Represent expected validation, conversion, and domain failures with explicit
  result unions.
- Host tools return `ToolResult.success(value)` or
  `ToolResult.failure(publicMessage)`.
- Do not infer failure from arbitrary returned JSON.
- Avoid `try`/`catch` except at throwing dependency boundaries, framework
  boundaries, or ownership cleanup.
- Keep each catch scoped to the operation whose failure it understands.
- Do not combine tool invocation, serialization, VM allocation, and settlement
  under one catch.
- Classify only recognized failures. Within a thread, propagate unexpected
  infrastructure exceptions with their original cause.
- Across the worker boundary, send only controlled failure categories. The host
  promise rejects with a new error; arbitrary worker exception messages, stacks,
  and original error identity are not transferred. This differs from guest-visible
  tool failures, which expose only deliberately public messages.
- Keep guest exceptions and rejected promises consistent with native JavaScript.
- Only deliberately public tool failure messages cross into the guest.
- Unexpected host callback exceptions become a private, generic guest rejection.
- Never expose private host messages, stacks, or credentials to guest code.
- Do not retry VM operations after an infrastructure failure.
- Do not swallow failures or replace them with success-shaped fallbacks.
- Error messages should explain what failed. Include a next action when it is
  concrete and supported; avoid vague troubleshooting instructions.
- Do not invent a cause when it is unknown.

## QuickJS Ownership and Boundaries

- Read installed QuickJS source/types before using unfamiliar APIs.
- Dispose every owned handle, context, and runtime on every exit path.
- Prefer `using` for scoped disposable resources.
- Distinguish borrowed handles from owned handles.
- Document surprising SDK ownership behavior.
- Transfer ownership only after initialization succeeds.
- Keep deferred promise resolvers alive until settlement or execution cleanup.
- Late host completions must not access a closed VM.
- Preserve infrastructure failures even while guest jobs keep arriving.
- Compile submitted source separately from the private guest prelude.
- Validate the complete function-body wrapper, not a restricted language subset.
- Do not expose raw host callbacks or private prelude bindings to submitted code.
- Cross the host/guest boundary through explicit serialization, not shared
  executable object graphs.
- Do not claim cancellation, rollback, isolation, or exactly-once behavior that
  the implementation does not provide.

## Comments and Documentation

- Code explains **How** through names, types, and control flow.
- Tests specify **What**: observable contracts, with names that match their assertions.
- Commit logs explain **Why**: the problem and motivation, not a list of edits.
- Code comments explain **Why not**: why an apparently simpler alternative would
  break a constraint or guarantee. Do not invent rationale or narrate readable code.
- Keep concise API and ownership documentation where callers need the contract.
- Explain non-obvious constraints, ownership rules, and surprising behavior.
- Do not narrate obvious assignments or control flow.
- Keep comments accurate when changing implementation.
- Document public behavior, important guarantees, and current limitations.
- Prefer precise claims over broad claims of safety or production readiness.

## Testing

- Use `bun:test`.
- Test actual implementation and observable semantics.
- Prefer public contract tests with explicit expected results. Give each behavior
  one primary owner; additional boundary tests must cover a distinct failure risk.
  Test shared validation rules once, then verify boundary wiring and field-specific limits.
- Each package owns its tests, helpers, and fixtures. Organize them by boundary:
  `tests/unit/` for isolated logic, `tests/component/`
  for focused subsystem/ownership tests, and `tests/integration/` for public
  execution and process lifecycle. See `docs/testing.md` for placement and examples.
  Tests may use another package's public API, never its internals or test files.
- Keep one behavior per test, with visible setup, action, and assertions. Use named
  table cases for data variations; separate scenarios with different event sequences.
- Share mechanical setup in `tests/support/`; keep scenario inputs, ordering, and
  expected outcomes visible in the test. Executable fixtures belong in `tests/fixtures/`.
- Name recovery tests as recovery tests; claims about disposal require assertions
  on the actual owned resources.
- Assert listener lifetime and required ordering, rather than exact registration
  sequences. Call counts are useful when they prove no retry or duplicate dispatch.
- Use explicit start/release gates for ordering contracts; use real timers when
  timing is the behavior under test.
- Give independent contracts separate tests and table variations descriptive names.
- Use `rejectionOf` from `tests/support/rejection.ts` when inspecting rejection reasons;
  it fails on fulfillment rather than treating resolved values as failures.
- Do not duplicate implementation logic inside tests.
- Prefer real QuickJS execution over mocks.
- Allow narrowly scoped fault injection for infrastructure failures that cannot
  be triggered reliably otherwise.
- Restore spies and injected behavior on every exit path.
- Avoid modifying host globals unless there is no practical alternative.
- Guest-global mutation tests are legitimate sandbox boundary tests.
- Cover disposal, recovery, late completion, and private-error handling.
- Preserve coverage of supported behavior when consolidating tests. Remove a
  redundant case only when a named surviving test protects the same contract.
- Do not weaken or remove a correct test to make checks pass.
- Run package-local suites with `bun run --cwd packages/<package> test` or `check`.
  Root commands coordinate package checks; there is no root test suite. `bun run check`
  also verifies built tarballs in isolated consumers; do not substitute source-only checks.

## Formatting, Linting, and Checks

- Use Oxfmt for formatting and Oxlint for linting.
- Use blank lines after guards/control-flow blocks, before standalone returns,
  and around multiline declarations (including `using`). Oxlint's
  `@stylistic/padding-line-between-statements` rule enforces these boundaries.
- Keep related short declarations and assertions grouped; separate logical phases
  such as test setup, execution, and assertions with a blank line.
- Preserve established formatting rather than introducing cosmetic churn.
- Prefer focused native lint rules over blanket restrictive presets.
- Do not ban legitimate `unknown`, boundary validation, or exceptions merely to
  satisfy a lint preset.
- Keep nuanced architecture and ownership rules in this guide and code review.
- Do not suppress lint findings, add unsafe casts, or restructure correct code
  solely to make a rule pass.
- Run `bun run typecheck`, not `tsc` directly.
- Before completing changes, run:
  - `bun run check`
  - `bun run example`
- Report precisely what could not be verified and why.

## Change Discipline

- Make minimal, cohesive changes.
- Preserve unrelated user work.
- Do not introduce speculative abstractions or configuration.
- Do not commit, push, initialize Git, or create pull requests unless requested.
- Keep explanations, commit messages, and summaries concise.

## References

- `~/Code/personal/pi/packages/codemode/`
- `~/Code/personal/executor/packages/kernel/runtime-quickjs/`

Read each reference repository's instructions before inspecting its source.
