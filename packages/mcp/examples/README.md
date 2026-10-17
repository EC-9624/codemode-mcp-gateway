# MCP adapter examples

Requires the full workspace and Bun 1.4.3. From the repository root, install
dependencies with `bun install --frozen-lockfile --ignore-scripts`.

| Example                                 | Command from workspace root                                     | What to expect                                                                                                                           |
| --------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [Adapt an upstream client](client.ts)   | `bun run --cwd packages/mcp example` (or `bun run example:mcp`) | A host execution report containing sum `5`, upstream `isError: true` handled as data, 3,000 records, and a caught input-validation error |
| [Expose a borrowed executor](server.ts) | `bun run --cwd packages/mcp example:server`                     | MCP `{ content: [{ type: "text", text: "42" }] }`, not a host report                                                                     |

The client example starts the shared synthetic `examples/shared/mcp-server.ts`
upstream over stdio and closes it afterward. The server example connects an SDK
client in memory and closes both ends. The application selects QuickJS; the MCP
adapter itself constructs neither an engine nor an upstream connection.

No setup, credentials, external providers, model calls, or build is needed.
Both examples import package roots. Clients own their connections; closing the
MCP execute server drains its requests without disposing the borrowed executor.
