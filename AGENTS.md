# MCM

A code-mode sandbox built from first principles for learning. Pi and Executor
are design references, not runtime dependencies.

## Scope

- Start with synchronous QuickJS execution, then add an async host-call bridge,
  worker isolation, and finally MCP integration.
- Keep each milestone small, runnable, and explained in the README.
- Do not add hosting, OAuth, persistence, or evaluation infrastructure without
  a concrete request.

## Conventions

- Bun, strict TypeScript, and `bun:test`. Use plain TypeScript, not Effect.
- Prefer simple functions and explicit result unions over frameworks or
  speculative abstractions.
- Never introduce `any`, non-null assertions, or unsafe type assertions.
- Read installed QuickJS source/types before using unfamiliar APIs.
- Dispose every owned VM handle, context, and runtime on every exit path.
- Prefer `using` for disposable resources and early returns over nested
  cleanup blocks or nested ternaries.
- Explain surprising VM behavior and ownership rules, not obvious code.
- Run `bun run check` and the example before completing changes.
- Never commit, push, or initialize Git unless requested.

## References

- `~/Code/personal/pi/packages/codemode/`
- `~/Code/personal/executor/packages/kernel/runtime-quickjs/`

Read each reference repository's instructions before inspecting its source.
