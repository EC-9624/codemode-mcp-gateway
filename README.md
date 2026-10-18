# codemode-mcp-gateway

A code-mode gateway for MCP tools. Connect your upstream MCP servers once, then let
coding agents discover tools, compose calls, and filter results with JavaScript.
The gateway exposes one MCP tool, `execute`, rather than putting every upstream
schema into the client's tool catalog. It does not run a model or agent loop.

Development and source/package runs require **Bun 1.4.3**, pinned in `.bun-version`.
The standalone `gw` executable includes its runtime. Package names are provisional;
nothing has been published. This is a working MVP, not an OS-isolated or
production-hardened sandbox.

## Try the local demo

```sh
bun install --frozen-lockfile --ignore-scripts
bun run example:server
```

The example launches a client, gateway, and synthetic math MCP upstream, discovers
`add`, inspects its schema, and returns 5. Repository commands run source directly;
these examples do not require a build.

No configuration, credentials, model calls, or external provider is needed. See
the [example index](examples/README.md) for package-specific commands and expected output.

## Install and set up gw

```sh
bun install --frozen-lockfile --ignore-scripts
bun run install:gw
"$HOME/.local/bin/gw" --version
```

This builds `dist/gw` and installs it at `~/.local/bin/gw`. Add that directory to
PATH yourself, or use the absolute path. No shell files, clients, or services are
changed. Use `--force` to explicitly replace an installed executable; use
`bun run build:standalone` for build-only output. Builds target the host platform;
standalone checks currently establish macOS arm64, not a cross-platform release.
No downloadable release binaries or registry packages are published yet.

```sh
gw setup
# Edit ~/.config/codemode-mcp-gateway/config.json to define your upstreams.
gw check
gw login --server notion  # Only for a configured OAuth upstream named notion.
gw serve
```

`setup` creates only missing configuration and a private persistent HTTP token;
it never configures clients, authorizes upstreams, or starts a process. Its starter
has no upstreams and is not runnable until edited. For example, a Notion-only
configuration is `{ "mcp": { "servers": { "notion": { "type": "remote",
"url": "https://mcp.notion.com/mcp", "oauth": {} } } } }`.

Keep `gw serve` running in its terminal. In another terminal, `gw doctor` reports
the running gateway's upstream status, and `gw token` explicitly prints the secret
for manual client registration. Connect clients to `http://127.0.0.1:4791/mcp`
with `Authorization: Bearer <your-private-token>`. Never log or commit that token.
See [local deployment](docs/local-installation.md) for full Codex/Claude Code
configuration examples, nondefault paths, updates, and token rotation.

`gw serve` runs the foreground loopback HTTP MCP service. It reads the setup-created
token or an explicit `GW_HTTP_TOKEN` override (32–256 letters, digits, underscores,
or hyphens); configure clients
to send the same token as `Authorization: Bearer <token>` to `/mcp`.
The token survives restarts when supplied unchanged. Rotate it explicitly by
changing it, restarting the gateway, and updating clients; a leaked token remains
valid until rotation. Only `gw setup` may create a token; serving never provisions
or rotates it. The gateway never edits client configs, installs itself, or manages
an OS service. An occupied port is an error,
not a request to adopt or restart its owner. No per-client gateway or bridge is needed.
`gw` alone shows help.
Explicit `gw serve --stdio` and legacy positional-config invocations retain direct
stdio for development and examples. Both transports expose `execute({ code })`.
Diagnostics use stderr.
Configure named upstreams under `mcp.servers`; this example assumes you supply a
local `mcp-server.ts` beside your configuration:

```json
{
  "mcp": {
    "servers": {
      "math": { "type": "local", "command": ["bun", "./mcp-server.ts"] },
      "notion": { "type": "remote", "url": "https://mcp.notion.com/mcp", "oauth": {} }
    }
  }
}
```

Local paths resolve from the configuration directory. The included
[`packages/gateway/examples/multi.json`](packages/gateway/examples/multi.json) references the shared math fixture and longer
Notion deadlines. Serving and management commands use
`$XDG_CONFIG_HOME/codemode-mcp-gateway/config.json` or `~/.config/codemode-mcp-gateway/config.json`; `--config <path>`
or a positional path overrides it. `check` validates without connecting; `doctor`
queries the actual running service using the same saved token or override (`doctor --stdio` explicitly
probes fresh connections and needs no gateway HTTP token).
Login is explicit and interactive; serving
uses private file-backed credentials and noninteractive refresh. OAuth snapshots
live under `$XDG_STATE_HOME/codemode-mcp-gateway/credentials` (default
`~/.local/state/codemode-mcp-gateway/credentials`), not Keychain. Files are plaintext
with owner-only permissions. Existing Keychain users must log in again; old entries
are left untouched. Logout removes local credentials, not the upstream grant.

Upstreams initialize independently, so MCP readiness does not imply tool readiness.
Discovery reports server availability; connected upstreams remain usable when
others fail. Credential changes can recover waiting servers, and connection
failures use backoff; failed scripts are never automatically replayed. See the
[CLI/upstream guide](packages/gateway/README.md#named-upstreams-and-hot-recovery)
and [local OAuth limitations](packages/gateway/README.md#local-oauth).

### Discover, inspect, call

Submit async function bodies to `execute`; top-level `await` and `return` work:

```js
return await tools.searchTools({ query: "add numbers", server: "math" });
```

Search returns `{ tools, total, nextOffset, servers }`: five ranked name/short-description
previews by default, without schemas. Use the exact qualified name from discovery:

```js
return await tools.describeTool({ name: "math.add" });
```

After inspecting the schema and checking that the server is connected:

```js
const response = await tools["math.add"]({ a: 2, b: 3 });
if (response.isError) return response.content;
return response.structuredContent.sum;
```

The example returns `5`. Upstream MCP results remain complete inside the script;
`isError` is data the script must inspect. For more search matches, repeat the query
with `offset: nextOffset` until null; `limit` changes page size. Discovery helpers
share the tool-call budget. See the [discovery contract](docs/reference.md#catalog-and-discovery).

### Returned output and spill files

Agent-facing MCP responses contain **text only**: strings as plain text, other
returned values as compact JSON, or useful error text. There is no report envelope,
call list, or `structuredContent`; `isError: true` appears only on failure. Host
libraries retain execution reports with metadata-only call summaries.

Above **40,000 UTF-8 bytes**, the gateway returns a UTF-8-safe head/tail preview and
an absolute path to the full output in a private local file. Use native harness
file/shell tools on the shared filesystem; there is no custom artifact tool.
Long single-line JSON may require shell parsing rather than a line-based reader.
Files last until their MCP session is retired; closing one client never deletes
another client's output. HTTP DELETE retires immediately, and sessions without
open requests/event streams retire after a 60-second grace. Crashes can leave files
behind. There is no total storage quota or startup sweep. A failed save preserves the preview and
execution outcome and reports that full output could not be saved.

The hard final-output default is **16 MiB** in the gateway, **256 KiB** in the
library. This is not streaming and does not bound temporary tool/transport
allocations. See [output/failure details](packages/gateway/README.md#results-and-failures).

## How it works

```text
MCP client -> execute({ code }) -> fresh worker + QuickJS guest
                                -> host tool adapter -> upstream MCP server
           <- returned value/error text, or a saved-output preview and local path
```

The host owns tool connections and callbacks; the guest sees only injected tools.
Discovery and bindings are snapshotted for each execution. A running gateway shares
one executor and its upstreams across its MCP sessions.

### Packages

| Package                                                         | Responsibility                                                                   |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [`@codemode-mcp-gateway/codemode`](packages/codemode/README.md) | Execute JavaScript with host tools; no MCP dependency                            |
| [`@codemode-mcp-gateway/mcp`](packages/mcp/README.md)           | Adapt connected MCP clients or expose a borrowed executor as an MCP server       |
| [`codemode-mcp-gateway`](packages/gateway/README.md)            | Compose upstreams, discovery, configuration, OAuth, lifecycle, API, and `gw` CLI |

Each package has its own README, runnable `examples/`, public entry, and tests.

Codemode owns workers/VMs; MCP uses only codemode's public contracts. Gateway owns
connections and selects QuickJS. Importing its programmatic entry starts no CLI or
process listeners. All three support Bun only. MCP and gateway remain private;
codemode is independently packable. Import package roots, not runtime deep paths.

For standalone execution:

```ts
import { CodeExecutor, ToolResult } from "@codemode-mcp-gateway/codemode";

const sandbox = new CodeExecutor({ tools: { answer: () => ToolResult.success(42) } });
const report = await sandbox.execute("return await tools.answer();");
console.log(report.result); // { ok: true, value: 42 }
```

## Defaults and limitations

- Each execution owns a fresh worker and VM. Tools run on the host thread and cross
  JSON; scripts have no direct host filesystem, network, or process access.
- Policy is constructor-owned; per-execution tool snapshots and cancellation do
  not override limits. Expected guest failures resolve in reports; infrastructure
  failures reject. Private host exceptions are not exposed to scripts.
- Four executions per executor by default, including cleanup. Excess submissions
  fail immediately without a worker, queue, or retry. Separate gateways have
  independent budgets.
- Per execution: 100 total calls, ten active calls; additional calls queue in
  invocation order. Guest memory defaults to 256 MiB, stack to 1 MiB, source to
  256 KiB. Gateway guest/total deadlines are 5/10 seconds; library deadlines are
  unset. See [exact limits](packages/codemode/README.md#limits-and-boundaries).
- Workers are not OS/process isolation. Guest limits do not bound aggregate
  concurrent memory, host work, or tool payloads. Deadlines are not hard response
  latency caps; host work and cleanup can delay completion.
- Cancellation is cooperative for host callbacks and cannot roll back upstream
  side effects. No remote agent hosting, model loop, or team credential management
  is implemented. The agent-facing CLI defaults to loopback HTTP; explicit stdio remains available.

## Testing and distribution

```sh
bun run check
bun run example
bun run example:mcp
bun run --cwd packages/codemode test
bun run --cwd packages/mcp test
bun run --cwd packages/gateway test
bun run verify:packages
bun run verify:packages:clean
```

Each package owns its tests and local `check` command. Root `check` coordinates
builds, typechecking, lint, formatting checks, tests, and packed-consumer verification;
there is no root test suite. `verify:packages` builds/packs all workspaces and checks
unrelated temporary consumers, declarations, workers, MCP, gateway API, and packaged
`gw`. Temporary overrides stand in for unpublished registry versions; nothing is
published. Use `bun run typecheck` for typechecking and `bun run format` for formatting.
The clean variant copies current source without inherited installs/builds, then
performs a frozen install, `install:gw` in an isolated HOME, and the same consumer checks. Local
packing does not rely on lifecycle hooks; script-disable settings remain respected.
See the [script guide](scripts/README.md) for build/installation commands versus
optional diagnostics and archived studies.

## Documentation and release status

- [Documentation index](docs/README.md): current user/developer guides and optional diagnostics.
- [Behavior and ownership reference](docs/reference.md): exact execution/MCP contracts.
- [Historical evidence](docs/archive/README.md): dated investigations, interoperability,
  and retired deployment workflows; not current onboarding or fresh validation.
- [Distribution checklist](docs/distribution-readiness.md): public-source, binary,
  license, and registry decisions tracked separately.
- [Project conventions](AGENTS.md): development rules.

This project is unreleased. A public source repository does not imply published
packages, downloadable binaries, or production readiness. The project license has
not yet been chosen; third-party notices are not a license for the surrounding code.
