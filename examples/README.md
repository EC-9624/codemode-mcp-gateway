# Examples

Examples belong to the package whose public API they demonstrate. Run source examples
with **Bun 1.4.3**, after `bun install --frozen-lockfile --ignore-scripts` from the
workspace root. No build is required. Package-local commands select development exports;
installed consumers use compiled public exports instead.

| Package  | Guide                                                         | Root shortcut            | Expected result                         |
| -------- | ------------------------------------------------------------- | ------------------------ | --------------------------------------- |
| Codemode | [Execution examples](../packages/codemode/examples/README.md) | `bun run example`        | Host report with value `42`             |
| MCP      | [Adapter examples](../packages/mcp/examples/README.md)        | `bun run example:mcp`    | Sum `5`, handled failure, 3,000 records |
| Gateway  | [Gateway examples](../packages/gateway/examples/README.md)    | `bun run example:server` | Discover/describe `math.add`, then `5`  |

The default examples are synthetic and local: no setup, credentials, provider access,
or paid model calls. HTTP needs a separately running gateway and a private token;
Notion needs explicit interactive login. Neither is run implicitly by the defaults.

`shared/mcp-server.ts` and `shared/mcp-tools.ts` are the shared synthetic upstream,
not application runtime dependencies. Configured upstreams can require Bun even
when the standalone gateway itself needs no external runtime. Keep this checkout
intact when running its examples; TypeScript examples are not shipped in tarballs.
