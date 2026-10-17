# Codemode examples

Requires the full workspace and Bun 1.4.3. From the repository root, install
dependencies with `bun install --frozen-lockfile --ignore-scripts`.

| Example                            | Command from workspace root                                      | What to expect                                                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [Minimal execution](basic.ts)      | `bun run --cwd packages/codemode example` (or `bun run example`) | `{ result: { ok: true, value: 42 }, calls: [...] }`                                                                                   |
| [Advanced contracts](contracts.ts) | `bun run --cwd packages/codemode example:contracts`              | Success, script errors, guest/total deadlines, source/output/call limits, cancellation, discovery, and typed-tool validation/recovery |

The advanced example's failures are intentional demonstrations; they are not
installation failures. The cancellation example creates a synthetic invoice first,
then cancels a held call: cancellation does not roll back prior effects.

Both use public package-root imports. No MCP server, external service, credentials,
or build is needed. The minimal example sets both deadlines explicitly; the library
leaves them unset by default. No executor `close()` is needed because each execution
awaits its own worker cleanup. These examples are not substitutes for contract tests.
