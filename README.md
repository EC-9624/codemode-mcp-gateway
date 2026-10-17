# codemode-mcp-gateway

A code-mode gateway for MCP tools. An agent writes JavaScript; the gateway runs it
in QuickJS with explicitly supplied tools. Reusable libraries provide execution
and MCP adaptation without running an agent/model loop.

Development and source/package runs require **Bun 1.4.3**, pinned in `.bun-version`.
The standalone `gw` executable includes its runtime. Package names are provisional;
nothing has been published. This is a working MVP, not an OS-isolated or
production-hardened sandbox.

Build the **`gw`** application with `bun run build:standalone`; the result is
`dist/gw` for the current platform. No release binaries have been published.
Installation, process supervision, upstream definitions, and MCP client configuration
are user-managed. See [local deployment](docs/local-installation.md).

```sh
bun run build:standalone
./dist/gw setup
# Edit the displayed configuration to add your upstream MCP servers.
./dist/gw check
./dist/gw serve
```

`setup` explicitly creates a starter configuration and a private persistent token;
it never replaces existing files, configures clients, or starts a process.
The starter has no upstreams and is not runnable until edited. `gw token` explicitly
reveals the effective token for manual client setup. Local upstream commands may
still require their own runtimes even though the gateway executable does not.

## Quick start

```sh
bun install --frozen-lockfile --ignore-scripts
bun run example:server
```

The example launches a client, gateway, and synthetic math MCP upstream, discovers
`add`, inspects its schema, and returns 5. Repository commands run source directly;
these examples do not require a build.

## Agent-facing service

```sh
bun run gw setup
bun run gw serve --config examples/multi.json
bun run gw check examples/multi.json --json
bun run gw doctor --stdio examples/multi.json --json
bun run gw login examples/multi.json --server notion
```

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
Configure named upstreams under `mcp.servers`:

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
[`examples/multi.json`](examples/multi.json) supplies the math script and longer
Notion deadlines. Serving and management commands use
`$XDG_CONFIG_HOME/codemode-mcp-gateway/config.json` or `~/.config/codemode-mcp-gateway/config.json`; `--config <path>`
or a positional path overrides it. `check` validates without connecting; `doctor`
queries the actual running service using the same saved token or override (`doctor --stdio` explicitly
probes fresh connections and needs no gateway HTTP token).
Login is explicit and interactive; serving
uses saved OS credentials and noninteractive refresh. Logout removes local
credentials, not the upstream grant.

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

## Packages

| Package                                                         | Responsibility                                                                   |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [`@codemode-mcp-gateway/codemode`](packages/codemode/README.md) | Execute JavaScript with host tools; no MCP dependency                            |
| [`@codemode-mcp-gateway/mcp`](packages/mcp/README.md)           | Adapt connected MCP clients or expose a borrowed executor as an MCP server       |
| [`codemode-mcp-gateway`](packages/gateway/README.md)            | Compose upstreams, discovery, configuration, OAuth, lifecycle, API, and `gw` CLI |

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
performs a frozen install, explicit build, and the same consumer checks. Local
packing does not rely on lifecycle hooks; script-disable settings remain respected.

Opt-in local integration diagnostics:

```sh
bun run validate:agents
bun run baseline:gateway --smoke
bun run baseline:gateway --minutes 30
bun run validate:http-idle
```

The [four-workflow diagnostic](docs/agent-validation.md) checks the real CLI and
saved-output retrieval. The [managed transport soak](docs/gateway-soak.md) exercises
stdio and loopback HTTP upstreams; run measurements serially. Both use scripted
synthetic traffic, not language-model agents or live providers.

For separately approved **actual model-agent calls**, use
`bun run validate:models --approve-model-calls`. This runs four Sol Fast sessions
against synthetic local documents and can incur provider charges. See
[actual-agent validation](docs/model-validation.md) for permissions, evidence, and limits.

Builds emit ESM/declarations and the worker into `dist/`. Repository scripts use the
`development` export condition; installed consumers use compiled exports. The
patched QuickJS SDK JavaScript is bundled so standalone consumers receive its
memory-growth fix; WASM variants remain external. See [patch notes](patches/README.md).

## Real-upstream validation and execution baseline

After explicit login, run the read-only Notion workflow with private test inputs:

```sh
bun run gw login examples/notion.json
bun run example:notion examples/notion.json "specific search phrase" \
  --page "<page-url-or-id>" --expect "<known text>" --runs 3
```

`--agents` supports overlapping scripted workflows, not LLM agents. See the
[historical baseline and measurement methods](docs/investigations.md#real-upstream-validation-and-execution-baseline)
and [installed validation](docs/installed-validation.md) for saved-credential checks
and recorded external-consumer/OpenCode evidence. Do not commit private queries or page data.

## Current status and evidence

The [finite host-runtime study](docs/runtime-study.md) supports Bun 1.4.3 for the
identified allocator-retention issue rather than a Node migration. It does not
establish a hard memory bound, indefinite stability, or global leak freedom. The
separate QuickJS SDK memory-growth patch remains necessary in the integrated tree.

Historical measurements, agent sessions, response formats, and slices 1–32 are
preserved in [investigations](docs/investigations.md), not presented as fresh runs
against today's tree. The current [stdio observer](scripts/observe-gateway.ts)
records MCP outcomes, timing, and request/session/process correlation/overlap—not
host-only call counts or execution failure categories. The new four-workflow CLI
diagnostic, managed-gateway smoke, and a 30-minute managed transport soak passed
locally on Bun 1.4.3. The soak completed 180 cycles and 3,192 requests; its guide
records one HTTP idle-timeout warning and the scope of its memory observations.
The later idle probe characterized resets/warnings; the updated fixture smoke
passed with a justified explicit idle timeout, without rewriting the old soak.
Four actual Sol Fast sessions also passed shared-gateway, hidden saved-output
retrieval, actionable-error, and cleanup checks. Longer ordinary agent/provider use
and aggregate/payload hardening remain gaps; bounded local runs are not production evidence.

The [distribution checklist](docs/distribution-readiness.md) records release blockers
and owner decisions. Local use is the current goal; release work is deferred and
this project is not approved for publication.

Further reading: [behavior/ownership reference](docs/reference.md),
[testing conventions](docs/testing.md), [bounded reliability diagnostic](docs/reliability.md),
[WASM memory investigation](docs/wasm-memory.md), and [project conventions](AGENTS.md).
