# codemode-mcp-gateway

A Bun MCP gateway that lets coding agents discover and compose multiple upstream
MCP servers' tools through JavaScript. This product package provides both a
programmatic API and the `gw` executable, composing `@codemode-mcp-gateway/codemode` and `@codemode-mcp-gateway/mcp`.
The package remains private while its API matures.

## Run from the repository

```sh
bun install --frozen-lockfile --ignore-scripts
bun run --cwd packages/gateway example
```

Source/package runs and builds require Bun **1.4.3**. `bun run build:standalone`
produces `dist/gw` for the current platform, with Bun, internal libraries, workers,
and QuickJS WASM embedded. It runs outside the checkout without dependencies or
a separate Bun installation. No release binaries are published yet.
From the workspace root, `bun run install:gw` combines the build and installation
to `~/.local/bin/gw`; `--force` is required to replace an existing file or symlink.
It does not install dependencies, change PATH, prepare credentials, or start a process.
`gw setup` explicitly prepares a starter configuration without overwriting existing
files. The starter needs user-supplied upstreams before it can run. `gw serve` uses
authenticated loopback HTTP by default; `--transport stdio` selects client-owned stdio.
Only `gw setup --transport http` prepares a private persistent HTTP token;
`gw serve --transport http` reads that token or the `GW_HTTP_TOKEN` override.
Client configuration, installation, and process supervision remain user-managed.
The gateway never edits client configs. Existing upstream definitions and explicit OAuth login remain.
The package's `example` (root
shortcut `example:server`) starts a client and the gateway,
discovers the synthetic upstream's tools, and executes a call end to end.
In stdio mode stdout is exclusively MCP traffic; diagnostics use stderr.

Examples live in `packages/gateway/examples/` in the checkout, not tarballs. They
include a local stdio demo, authenticated HTTP client, and optional real-account
Notion workflow. The default demo prints `5` and needs no setup, credentials, or model.

For standalone HTTP use after building/installing, run `gw setup --transport http`, add your upstreams
to its displayed configuration, validate with `gw config check`, explicitly authorize
OAuth upstreams with `gw auth login <server>`, then keep `gw serve` running and
register its HTTP URL and bearer header in your clients. For client-owned stdio,
use `args: ["serve", "--transport", "stdio"]` (and `--config <path>` if needed).
Each stdio launch owns its gateway, executor budget, and upstream connections;
closing stdin requests cleanup. `gw probe` opens separate diagnostic connections.
No configuration changes are watched; restart after editing upstream definitions.

HTTP clients use `http://127.0.0.1:4791/mcp` (or your configured port) with
`Authorization: Bearer <your-private-token>`. `gw status` queries only a running
HTTP process; `gw token show` explicitly reveals its token. Local upstreams can still require
their own runtimes even when the gateway binary itself needs none. Stop the gateway,
replace the binary, and restart for updates; gateway files and OAuth credentials
remain separate from the executable.

## CLI and default configuration

`gw` without arguments and command groups show help. `gw help auth login` and
`gw auth login --help` show focused help. Configuration resolves
from `--config <path>` (or `-c`), then
`$XDG_CONFIG_HOME/codemode-mcp-gateway/config.json`, otherwise `~/.config/codemode-mcp-gateway/config.json`.
An empty XDG variable uses the home fallback; a relative XDG path is rejected.
The working directory is not searched implicitly.
Root help groups getting-started, inspection, and authentication commands and shows
only root flags. Focused help documents command-specific flags, defaults, and examples.

The repository's `docs/local-installation.md` expands installation and native client
configuration. This README keeps the runtime and credential contracts self-contained
for installed readers; `dist/index.d.ts` contains supported public API signatures.
There is no client provisioning or OS service-management command.

```sh
gw setup                   # Prepare configuration only; no HTTP token or process startup
gw serve                   # Foreground loopback HTTP service (default)
gw serve --config ./config.json
gw config check --json
gw probe notion --json     # Open/close fresh upstream connections
gw auth login notion
gw auth logout notion
gw setup --transport http  # Explicitly prepare an HTTP token as well
gw serve --transport stdio # Client-owned stdio; stdout is exclusively MCP
gw status notion --json    # Read only the running HTTP gateway
gw tools list              # First 50 tools across upstreams
gw tools list notion       # First 50 tools from one upstream
gw tools list --offset 50  # Next page across upstreams
gw tools list notion --offset 50 # Next page from one upstream
gw tools list notion --all # Print every tool for this upstream
gw tools list --all        # Print every tool across all upstreams
gw tools list notion --json # Complete, unpaginated metadata
gw token show              # Explicitly reveal the HTTP token; output is a secret
gw --help
gw --version
```

Configuration-based commands accept only `--config`/`-c`; `token show` accepts neither.
Unknown commands, extra positionals, repeated options, and command-incompatible flags
are errors. There are no legacy command aliases, positional configuration paths,
`--stdio`, or `--server` flags. `serve` and `setup` accept `--transport stdio|http`.
`serve` defaults to HTTP; `setup` defaults to configuration-only preparation and
creates a token only with `--transport http`. `config check` validates without connecting.
`probe [server]` opens/closes fresh diagnostic connections from local configuration
without requiring a gateway HTTP token. `status [server]` reads authenticated
status from the actual HTTP process and never probes upstreams. It selects from
the running service, not local upstream definitions, and fails if that server is
absent. It cannot inspect an existing stdio process. Terminal status includes the
gateway endpoint, PID, uptime, session count, and upstream table; public failure
details are wrapped, not truncated. `probe` uses the same table but explicitly
identifies a fresh connectivity check. Piped status/probe output has no headers:
TSV columns are upstream name, state, tool count, and public error message (empty
when absent). Records are not width-truncated; JSON retains service metadata.
`tools list [server]` also reads only the running HTTP gateway. It lists actual
tools across upstreams, or filters to one server, with 50 tools per page.
`--offset 50` selects the next page, with or without a server argument.
`--all` prints every tool for the selection (all upstreams if no server is supplied).
Terminal tables fit the available width and use single-line description previews.
Selected upstreams display original tool names; cross-upstream listings use qualified
names. Piped output has headerless TSV columns: qualified tool name and description,
without width truncation or styling. Descriptions are normalized to one line. Text
pagination hints move to stderr when piped; `--all` emits only records unless there
are unavailable-upstream warnings. Empty connected catalogs emit zero piped records.
Failed, connecting, and disabled upstreams produce brief stderr warnings; `gw status`
provides public failure details instead of duplicating its table in the tool listing.
Selection uses the running service's names, not local upstream definitions. No
connections, discovery refreshes, or tool calls are initiated. `--offset` cannot be
combined with `--all`. JSON is always complete, unpaginated,
and untruncated; combining `--json` with `--offset` or `--all` is an argument error.
JSON returns `{ ok: true, tools, servers }` with qualified names;
each tool has `server`, `name`, and its full `description`, without schemas or callbacks.
Older HTTP processes must be restarted with the updated executable to support listing.
Only `setup --transport http` creates `~/.local/state/codemode-mcp-gateway/token` (or under `XDG_STATE_HOME`),
with mode 0600 inside an owned, non-symlinked 0700 directory. Symlinked, nonprivate,
or invalid token files are refused, never fixed or replaced silently. Concurrent
setup publishes one complete token without clobbering another setup's value.
A supplied `GW_HTTP_TOKEN` overrides the file, including invalid/empty overrides,
which fail instead of falling back. It must contain 32–256 letters, digits,
underscores, or hyphens. Environment-managed setup validates the override but
does not save it or create another token. Set it from a private environment,
not a command argument or tracked configuration. The standalone executable does
not auto-load cwd `.env` or `bunfig.toml`; inject environment settings explicitly.
Clients send the same token in their bearer header. Restarting with the same token
does not revoke it. Rotation requires a changed token, gateway restart, and client
updates; leaked tokens remain usable until rotation. Only explicit `setup --transport http` creates
gateway credentials and only explicit `token show` prints one; normal serving, setup output,
and diagnostics never print it. Stdio setup/serving ignore gateway HTTP credentials.
An occupied HTTP port always fails without probing
or adopting the owning process, and no additional upstreams are started.
HTTP status contains process/session/upstream information, not client registration
or installation state. CLI status and tool-list requests reject redirects and validate the response;
they do not cryptographically authenticate the server. A process occupying the port
can capture the persistent token and impersonate an MCP/status server. Host/Origin
checks do not prevent this; trust the local port owner or use direct stdio.
Auth login/logout select a positional server name; the name
can be omitted when exactly one OAuth connection is configured. Logout removes
local credentials, not the upstream grant. Put options before `-- <server>` for
leading-hyphen names, for example `gw auth login --config ./config.json -- -notes`.

Exit codes: 0 for success, 1 for configuration/connection/authentication or runtime
failure, 2 for invalid arguments, 130 for SIGINT, and 143 for SIGTERM after cleanup.
The gateway remains running with failed upstreams. `probe` returns 1 when an enabled
upstream cannot connect; `status` returns 0 when status was retrieved, even for
degraded upstreams. `tools list` likewise returns 0 when the catalog was retrieved;
consult `servers` for availability. `--json` is accepted by `config check`, `probe`, `status`, and `tools list`,
never serving. These commands emit one JSON result for success or operational
failure; argument errors use stderr and exit 2. Setup exit 0
means files were prepared, not that upstream definitions, authorization, or clients
are ready; it reports configuration that still needs editing.
Setup next steps preserve the selected configuration path and show only the relevant
transport workflow. Slow probes and browser authorization show a delayed, transient
progress hint only on terminal stderr, never in JSON mode. Cancellation and failures
clear the hint before returning; no prompts or progress are introduced into MCP stdout.

## Named upstreams and hot recovery

```json
{
  "mcp": {
    "servers": {
      "notion": {
        "type": "remote",
        "url": "https://mcp.notion.com/mcp",
        "oauth": {}
      },
      "math": {
        "type": "local",
        "command": ["bun", "./mcp-server.ts"]
      }
    }
  }
}
```

Server names contain letters, digits, `_`, or `-`; `__proto__` is rejected. Local entries use a command
array, optional `cwd`, and optional `environment`. Remote entries use an HTTP(S)
`url`, optional header templates, and explicit `oauth: {}` (or `{ "scope": "read" }`)
to enable OAuth. Omitted/false `oauth` uses an unauthenticated or static-header
connection. Each entry accepts `disabled: true`. Local `cwd` defaults to the config
directory; a relative `cwd` resolves from there. Command arguments pass through
unchanged and the upstream interprets relative arguments from that working directory.
OAuth storage identity is the server name plus canonical URL.

Invalid configuration fails before connecting. Enabled upstreams initialize
independently; the agent-facing server is available while they connect. Expected
failures leave other upstreams usable, including when no upstream is ready yet.
State changes use readable messages on terminal stderr and structured JSON lines on
redirected stderr, for both HTTP and stdio. States are `disabled`,
`connecting`, `connected`, `needs-auth`, and `failed`, with tool counts and controlled
error categories in logs; status/discovery retains public recovery messages.
Status is last-observed connection state, not an active health check.

```js
return await tools.searchTools({ query: "search documents", server: "notion" });
```

Search returns `{ tools, total, nextOffset, servers }`. The optional
`server` filter selects one configured upstream; `servers` reports availability
even when no tools match. Calls use exact qualified names, such as
`tools["notion.notion-search"](args)` or `tools["math.add"]({ a: 2, b: 3 })`.
`describeTool` returns the selected tool's full schema. Names are never guessed or
silently aliased across upstreams; even an upstream tool named `searchTools` is
qualified and cannot overwrite the local helper.

Access-token refresh remains automatic. A missing/revoked grant or uncertain refresh
failure moves the affected server to `needs-auth`. Run `gw auth login notion`
using the same configuration; the gateway checks waiting credential records on a
one-second maintenance cadence and reconnects after an authorized snapshot changes.
Unchanged failed grants are not refreshed repeatedly, including after session expiry
or a late failure from a retired connection. Transient OAuth metadata, network timeouts,
and credential-read failures during setup retry with connection backoff. On an already
connected session, a pre-exchange credential-read/lock failure fails the current call;
subsequent executions can use the same session when storage becomes available.
Uncertain refresh responses and failed persistence after rotation still require
changed credentials. A changed issuer/resource binding, including one observed
during startup, triggers rebuilding that upstream's session.
An in-flight request that encounters the old binding may fail; subsequent executions
see the recovered connection. No failed script is automatically replayed.

Connection/discovery failures use automatic 5/10/20/40/60-second backoff, capped at
60 seconds. Attempts are single-flight per server. Maintenance can wait for an
ongoing bounded setup attempt, so the cadence is not a strict recovery deadline.
HTTP 404 responses for an established MCP session invalidate that connection and
schedule a fresh handshake. The failed call is not replayed. Ordinary upstream
tool/domain errors do not imply that a connection has failed.

Each `Gateway` owns one long-lived `CodeExecutor`. The gateway supplies combined
tool bindings, discovery helpers, and server-status snapshots for each execution;
the executor owns fixed limits and concurrency admission. Successful recovery
publishes a new catalog for subsequent executions without replacing the executor.
Running scripts retain their original discovery and tool bindings. Old connections
are retired after executions borrowing them settle. All MCP instances owned by the
gateway use that executor's budget, held through worker cleanup. Separate gateways
and CMG processes have independent budgets. Config edits are not
watched; credential recovery does not require a config reload or whole-server restart.

Model-facing guidance lives in `src/instructions.ts`: discovery, schema inspection,
exact-name invocation, result handling, and runtime limits. One description covers
the gateway's capabilities. Live tool and
server availability stays in discovery results rather than the static description.

Shutdown aborts setup/recovery and active executions, awaits their cleanup, and
closes owned connections. Remote session deletion is best-effort only when the
transport has already closed or authorization is known unusable; local cleanup
still completes. Unexpected infrastructure/cleanup failures remain host failures.

The repository's `packages/gateway/examples/multi.json` combines the shared synthetic
math server and Notion. Probe it with `bun run gw probe --config
packages/gateway/examples/multi.json`, or configure a client to spawn
`gw serve --transport stdio --config <absolute-config-path>`. Upstream definitions use
`mcp.servers`; optional top-level `sandbox` and `service` settings control policy/listening.

### Verified interoperability

The named gateway was exercised on Bun 1.4.2 with a real Notion HTTP connection
and the local math stdio server. `doctor --json` reported both connected, and one
compiled-CLI execution discovered Notion tools, returned `42` from `math.add`, and
verified a known page in the upstream search response. EOF shutdown exited with
code 0 and no signal.

OpenCode 2.0.29 and Claude Code 2.1.299 reported the compiled stdio gateway connected
from isolated temporary configuration. Codex CLI 0.162.1's native app-server MCP
client listed `execute`, inspected the math server's availability, and invoked
`math.add` through `execute` to return `42`. No model calls were used. A first Codex
probe called the known tool before its upstream was ready and received a script
error; the corrected probe used discovery's status before invocation. MCP readiness
does not mean every upstream is already connected.

Automated checks cover mixed transports, partial startup, cancellation, shared
capacity across catalog revisions/clients, initial missing credentials, revoked
grants, OAuth binding changes, and cross-process login adoption. Packed-consumer
checks exercise named upstreams through compiled exports. Live revocation/consent
recovery and native-client model reasoning were not exercised by this interoperability
check; those recovery scenarios use controlled OAuth fixtures.

## Agent workflow

The agent sees only `execute({ code })`. Submit this async function body to search:

```js
return await tools.searchTools({ query: "add numbers" });
```

Search returns `{ tools, total, nextOffset, servers }`, with five ranked name/description
previews by default and no schemas. `tools.describeTool({ name: "math.add" })` returns
the full description and input schema. Further pages use the same query with
`offset: nextOffset`; null marks completion, and `limit` changes the page size.
Agents can compose calls, paginate, and transform results as needed.

Wait until the selected server is connected, then inspect `math.add` and call it:

```js
const response = await tools["math.add"]({ a: 2, b: 3 });
if (response.isError) return response.content;
return response.structuredContent.sum;
```

For the synthetic upstream, the agent-facing MCP response is:

```json
{
  "content": [{ "type": "text", "text": "5" }]
}
```

Use bracket notation for exact qualified names. Local discovery calls share the execution budget.

## Structured logging

`gw serve` writes operational events to stderr: readable lines on a terminal, one
JSON object per line when redirected. Stdio stdout remains exclusively MCP; CLI
command results and explicit OAuth/browser instructions are not operational logs.

```sh
gw serve                          # Readable terminal events
gw serve 2>gateway.jsonl           # Structured records
GW_LOG_LEVEL=debug gw serve        # Include session lifecycle events
GW_LOG_LEVEL=warn gw serve         # Warnings and errors only
```

`GW_LOG_LEVEL` accepts `debug`, `info` (default), `warn`, or `error`. Invalid values
fail before serving. Initial upstream states/transitions and successful/cancelled
executions are informational. Session open/close events are debug; recoverable
upstream/tool failures and guest failures are warnings; infrastructure failures
are errors. Events include:

- `gw.service.started`, `gw.service.stopped`, `gw.service.failed`
- `gw.upstream.state_changed`
- `gw.session.opened`, `gw.session.closed`
- `gw.execution.finished`, `gw.tool.exception`
- `gw.protocol.failed`, `gw.output.save_failed`, `gw.logging.failed`

Records follow an OpenTelemetry-aligned logical shape, **not OTLP wire JSON**:

```json
{
  "timestamp": "2026-10-18T06:20:15.123Z",
  "severityNumber": 9,
  "severityText": "INFO",
  "eventName": "gw.execution.finished",
  "body": "Execution finished.",
  "resource": {
    "service.name": "codemode-mcp-gateway",
    "service.version": "0.0.0",
    "service.instance.id": "92a35cc7-6428-4692-afab-a6ec2797c565"
  },
  "instrumentationScope": { "name": "codemode-mcp-gateway", "version": "0.0.0" },
  "attributes": {
    "gw.transport": "http",
    "gw.session.id": "7364dfee-a32c-4627-89b3-7d5cbe0c313d",
    "gw.execution.id": "c236f042-691e-43a3-82fa-02c76e257b90",
    "gw.execution.outcome": "success",
    "gw.execution.duration_ms": 142.6,
    "gw.execution.calls.total": 3,
    "gw.execution.calls.completed": 3,
    "gw.execution.calls.interrupted": 0
  }
}
```

Session IDs are locally generated diagnostic identifiers, not HTTP MCP session IDs.
Call IDs are execution-local and must be correlated with execution IDs. Durations
use a monotonic clock and cover executor settlement/worker cleanup, not response
formatting or streaming. Outcomes distinguish `success`, `script_error`, `timeout`,
`cancelled`, `limit` (with `gw.execution.limit.resource`), and `infrastructure_error`.
A completed call means its response was serialized, not that its external operation
succeeded. An execution can catch a tool failure and still return successfully.

Gateway records never include submitted code, tool arguments/results, credentials,
headers, raw exception messages, or stacks. Explicit public errors still reach agents
under the existing protocol contract. Inherited local upstream stderr is separate,
untrusted output and may contain arbitrary text; it is not converted into these events.

The logger itself has no exporters or network delivery. Without telemetry configured,
trace/span fields are absent, not fabricated. Optional metrics/tracing is described
below; **logs are never exported by the gateway**. File redirection/rotation belongs
to the caller. Logging is best-effort: a failing sink is reported once without
changing execution outcomes. Buffered stderr above 64 KiB causes whole-record drops;
a later writable emission reports the drop count. A blocked or broken stderr may
prevent that warning from being delivered.

Programmatic callers opt in with `new Logger({ version, level, onLog })` and
`new Gateway(config, directory, { logger })`, imported from the package root.
`onLog` receives the same full records instead of the default renderer. Instances
do not install global hooks, start network activity, or need shutdown flushing.
`GatewayHttpServer` borrows the gateway's logger; importing the package does not log.

## Metrics and traces

Metrics/tracing is **opt-in**, using the official OpenTelemetry SDKs with
OTLP/HTTP protobuf. Ordinary `gw serve` has no telemetry network delivery. Enable
both signals with an explicit collector endpoint:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
gw serve
```

The base endpoint gets `/v1/traces` and `/v1/metrics` appended, preserving its path.
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`
override the base and are used as-is. A generic or per-signal endpoint enables the
corresponding signal unless its exporter is `none`. Explicit
`OTEL_TRACES_EXPORTER=otlp` or `OTEL_METRICS_EXPORTER=otlp` also enables that signal,
defaulting its endpoint to `http://localhost:4318`. Set either exporter to `none`
to disable it; `OTEL_SDK_DISABLED=true` disables both environment-configured signals.

Use `OTEL_EXPORTER_OTLP_HEADERS` for collector authentication; per-signal
`OTEL_EXPORTER_OTLP_TRACES_HEADERS` / `OTEL_EXPORTER_OTLP_METRICS_HEADERS` replace
the general headers. Values are comma-separated `name=value` pairs with percent
encoding. Gateway/upstream credentials are never reused for collector authentication.
URLs containing credentials or fragments are rejected without displaying their values.
Only `http/protobuf` is supported; explicit `grpc` or `http/json` is rejected.
There is no log exporter, automatic instrumentation, global provider registration,
context forwarding, or baggage propagation to upstreams.

### Collected metrics

| Instrument                        | Type/unit                    | Dimensions                                                           |
| --------------------------------- | ---------------------------- | -------------------------------------------------------------------- |
| `gw.execution.count`              | Counter, executions          | Inbound transport, admission, outcome, limit resource when relevant  |
| `gw.execution.duration`           | Histogram, seconds           | Same as execution count                                              |
| `gw.execution.active`             | Observable gauge, executions | None; actual occupied executor capacity                              |
| `gw.upstream.call.count`          | Counter, calls               | Upstream name, outgoing transport, observed outcome                  |
| `gw.upstream.call.duration`       | Histogram, seconds           | Same as call count                                                   |
| `gw.upstream.connection.count`    | Counter, attempts            | Upstream name, outgoing transport, initial/recovery trigger, outcome |
| `gw.upstream.connection.duration` | Histogram, seconds           | Same as connection count                                             |
| `gw.upstream.state`               | Observable gauge, upstreams  | Configured upstream name and current state                           |
| `gw.session.active`               | UpDownCounter, sessions      | Inbound transport                                                    |

Admission is `admitted` or `rejected`; pre-aborted, oversized, and capacity-rejected
submissions do not acquire a worker. Duration includes these quick rejections, so
filter on admission when comparing execution latency. Occupied capacity is read
from the executor: failed worker termination cannot falsely report a free slot.
The state gauge samples current snapshots and emits zero for other states, not a
cumulative count of transitions. Session counts include owned MCP contexts during
initialization, not only negotiated HTTP sessions returned by `/status`.

Call outcomes distinguish `response`, `mcp_tool_error`, `protocol_error`,
`authorization_error`, `tool_failure`, `exception`, and `interrupted`. The adapter
observes the actual MCP `isError` flag; failure-shaped payloads are never interpreted
as status. Call timing begins at host dispatch, includes validation/authentication
and upstream waits, and ends on return or interruption. It excludes guest queue
wait and bridge serialization. The guest bridge queues excess tool concurrency;
excess executions are rejected. Queue-wait timing is not collected yet.

Metrics are independent of log levels and trace sampling. No tool names, session
IDs, execution IDs, call IDs, trace IDs, raw URLs, or error messages are metric
dimensions. The configured OTLP reader limits each instrument to 128 time series.
Process/service identity is resource metadata, not a per-operation dimension.

### Trace boundaries and correlation

Each observed execution is an independent `gw.execution` root span. Its upstream
calls are `gw.upstream.call` client spans, with local call IDs and tool names as
attributes. Concurrent executions retain explicit, separate contexts. Connection
attempts use independent `gw.upstream.connect` roots with initialization/discovery
children; background recovery is not attached to an unrelated execution.

Execution spans carry outcome, admission, limits, and call counts. Logs emitted
within observed operations carry their real OTel trace/span context; `gw.tool.exception`
uses its call span when available. Known MCP tool errors mark the call span as failed,
but a script that handles an error can still have a successful execution span.
Interrupted calls end once and cannot be rewritten by late completions. This does
not establish cancellation or rollback of the external operation.

These are local gateway traces, not end-to-end distributed upstream traces. MCP
response formatting, HTTP SSE lifetime, guest queue wait, worker subphases, OAuth
refresh/lock waiting, and output-storage details are not separate spans or metrics
in this slice. No code, arguments, results, credentials, headers, or arbitrary
exception messages/stacks are included in telemetry.

### Ownership and export failures

The serving entry owns environment-configured telemetry and closes it after gateway
cleanup. Span queues are bounded (128 records); metrics export every 10 seconds and
on shutdown. `OTEL_EXPORTER_OTLP_TIMEOUT` and per-signal timeout overrides accept
1–2000 milliseconds (default 1000). Provider flush/shutdown waits are bounded;
shutdown waits at most 5 seconds, but cannot forcibly cancel arbitrary user-supplied
exporter code. Data can be dropped; there is no durable delivery guarantee.
Exporter failures emit one controlled `gw.telemetry.failed` warning per signal
without exposing private causes or changing execution results.

Programmatic composition can use `new Telemetry({ logger, spanExporter, metrics })`
with a metrics reader or exporter (a discriminated `kind` option), then pass
`{ logger, telemetry }` to `Gateway`. The gateway borrows telemetry; the caller
owns `telemetry.flush()` / `close()` or `await using`. No SDK is imported into the
codemode or MCP libraries; their narrow admission/context/response hooks remain
transport/telemetry independent.

## Results and failures

The response contains only the returned value: strings as plain text, other values
as compact JSON. There is no `structuredContent`, report envelope, or call list.
`isError` is omitted on success and included as `true` on failure. Upstream
`isError` remains data that scripts must inspect; catching a failure and returning
normally still succeeds.

Script errors, deadlines, cancellation, and execution limits show their useful
error messages. Infrastructure failures show `Sandbox execution failed.`; private
diagnostics stay host-side. MCP protocol errors reject in the script with the original tool name,
numeric code, and message, including SDK-generated output-schema errors. Error data
and stacks are excluded; messages are public and are not redacted. Unknown exceptions
still reject as `Host tool failed.`. For both cases, `gw` emits a `gw.tool.exception`
event with the qualified tool name, session/execution IDs, call ID, and a controlled
error category. Raw error messages and stacks are excluded from operational logs.
Cancellation cannot roll back upstream side effects. Metadata-only call reports
belong to the host executor; they are not sent in agent-facing MCP responses.

### Large output

Output above **40,000 UTF-8 bytes** is saved in full to a private local `.txt` file.
The agent sees a UTF-8-safe beginning/end preview, a truncation notice, and an
absolute `[Full output: /path/to/file.txt]` reference, all within the inline budget.
Use the harness's native file or shell tools to inspect it; there is no artifact
retrieval tool. Long single-line JSON may need shell-based parsing or filtering.
The harness and gateway must share filesystem access and permission to read the path.

Each MCP session lazily creates a `0700` OS temp directory and writes random filenames
exclusively with `0600` permissions. Files remain available across executions until
that session closes, after execution/presentation drains. HTTP DELETE closes one
session without affecting another; abandoned sessions retire after a 60-second
disconnect grace, while open requests/event streams keep their session alive.
Gateway shutdown closes all sessions. Crashes can leave files behind.
There is no per-file TTL, storage quota, or startup sweep; repeated
large output can accumulate disk usage. Save failures retain the preview and original
execution outcome, add `[Full output could not be saved.]`, and report diagnostics
host-side. Scripts are never automatically replayed.

The gateway's default hard final-output limit is **16 MiB**, configurable with
`sandbox.maxOutputBytes`. Above that limit, execution still reports an output-limit
error. The reusable library keeps its **256 KiB** default; this is not streaming
and does not bound temporary allocations or aggregate memory.

## Headers and execution policy

```json
{
  "mcp": {
    "servers": {
      "api": {
        "type": "remote",
        "url": "https://example.com/mcp",
        "headers": { "Authorization": "Bearer {env:CMG_UPSTREAM_TOKEN}" }
      }
    }
  }
}
```

Header templates expand host environment variables before connecting. Missing
variables mark that server failed before contacting it. Static headers do not enable OAuth or store credentials.
Optional `sandbox` settings configure the fixed QuickJS policy; app defaults use
a 5-second guest deadline and 10-second total deadline, unchanged by the library's
unset deadlines. Guest memory defaults to 256 MiB and hard final output to 16 MiB.
Other defaults come from codemode.

For example, configure execution capacity and total tool calls without request overrides:

```json
{
  "mcp": { "servers": { "math": { "type": "local", "command": ["bun", "upstream.ts"] } } },
  "sandbox": { "maxConcurrentExecutions": 4, "maxToolCalls": 20 }
}
```

Limits use codemode's exported `SandboxLimits` bounds: positive integers, at most
2147483647 except the stack guard's 4 MiB maximum. The default stack is 1 MiB,
source is 256 KiB, total calls are 100, and active calls are ten per execution.
Startup has separate budgets: 5 seconds for the upstream handshake, including its
initialized notification, and 15 seconds
for discovery. Configuration is loaded once; recovery republishes catalog snapshots.

Each gateway's `maxConcurrentExecutions` defaults to 4 across all its MCP instances, including
worker cleanup. Excess requests receive `isError: true` and an execution-capacity
message; they are not queued or retried. Separate gateways have separate budgets.
The per-execution `maxConcurrentToolCalls` limit remains independent: ten active
calls by default, with additional calls queued in invocation order. Queued calls
consume the total-call budget and their wait counts toward execution deadlines.

### Local OAuth

OAuth is opt-in for an explicitly named HTTP connection:

```json
{
  "mcp": {
    "servers": {
      "notion": {
        "type": "remote",
        "url": "https://mcp.notion.com/mcp",
        "oauth": {}
      }
    }
  }
}
```

From the repository root:

```sh
bun run gw auth login notion --config packages/gateway/examples/notion.json
bun run example:notion packages/gateway/examples/notion.json "your test page" \
  --page "<page-url-or-id>" --expect "<known text>" --runs 3
bun run gw auth logout notion --config packages/gateway/examples/notion.json
```

`login` displays an authorization URL and attempts to open the browser. One
five-minute deadline covers credential-lock acquisition, discovery, registration,
browser waiting, and code exchange. Credential-store operations already in progress
cannot be interrupted. PKCE, callback state, and issuer validation
protect the code exchange. Login uses the SDK's metadata, registration, and token
helpers, not a Notion-specific OAuth implementation. Discovery probes the upstream
without credentials for a `WWW-Authenticate` metadata URL, falling back to well-known
discovery when none is advertised. Optional `oauth.scope` requests an explicit
space-delimited scope. Otherwise, login requests the initial `WWW-Authenticate`
challenge's scopes, falling back to the protected resource's advertised
scopes, not every scope supported by the authorization server. `offline_access` is
added when either advertises it. Registration and browser consent request the same
scopes. To replace an existing incorrectly scoped registration, run
`gw auth logout <server>`, then `gw auth login <server>`; login alone reuses registration.

Serving is noninteractive: it loads the current user's saved credential files and
refreshes them without prompting for browser consent. Missing or revoked authorization
requires another explicit login. A permission/scope denial never automatically widens
the grant. Your upstream account and granted authorization determine access.

Credentials and registration details are plaintext versioned JSON snapshots in
`$XDG_STATE_HOME/codemode-mcp-gateway/credentials` (default
`~/.local/state/codemode-mcp-gateway/credentials`). The directory has mode 0700 and
each file has mode 0600; POSIX ownership and permissions are checked, and Windows
uses inherited user-directory ACLs. Symlinked directories/files and nonregular files
are rejected. Files are not encrypted by the application: processes running as your
user can read them. Keep this state outside Git and protect its backups.

There is no Keychain/libsecret backend, automatic migration, or storage fallback.
After upgrading from OS credential storage, restart the gateway and run `gw auth login`
again for each OAuth server. Existing Keychain entries and the old `cmg/locks`
directory are not read or deleted.

Server name and canonical upstream URL select a SHA-256-named file;
stored issuer/resource bindings are checked before refreshing.
Registration's loopback redirect URI is reused, so its port must be available during
later logins. Changing the name or URL selects a new entry; use the original configuration
to log out of the old entry.

The public `fileCredentialStore(connection, { directory? })` factory implements the
existing `CredentialStore` interface and does no I/O on construction. `load()` reads
fresh snapshots without creating missing files; absent credentials return success
with `undefined`. `save()` validates the snapshot and upstream binding, writes and
syncs a private temporary file, then atomically replaces the destination. Readers
see a complete old or new snapshot. `clear()` removes only that connection's file
and succeeds if already absent, including when the directory is absent. Malformed
snapshots return `invalid`; filesystem and permission failures return `storage`,
never absence. This is not a power-loss durability or cross-process fencing guarantee.

Hosts can use the same options with `login`, `logout`, and `Gateway`:

```ts
import { fileCredentialStore, type CredentialOptions } from "codemode-mcp-gateway";

const options = {
  store: (connection) =>
    fileCredentialStore(connection, { directory: "/absolute/private/credentials" }),
} satisfies CredentialOptions;
```

Custom credential directories must be absolute. All processes sharing credentials
must also share `lockDirectory` (the default is shared already); the store itself
does not acquire another lock. The separate gateway HTTP token is unchanged.

Multiple gateway processes can share the same connection and credentials. Ordinary
tool calls hold no credential lock. Before refreshing, CMG acquires a short
`proper-lockfile` lock, reloads credentials, and reuses a token already replaced by
another process. Otherwise it refreshes and saves under that lock. No native FFI is used.

The lock lives in `$XDG_STATE_HOME/codemode-mcp-gateway/locks`
(default `~/.local/state/codemode-mcp-gateway/locks`)
and contains no credentials. Empty `XDG_STATE_HOME` uses that default; relative values
are rejected so different working directories cannot split credential ownership.
CMG renews it every second; an abandoned lock becomes
eligible for recovery after 20 seconds. Acquisition waits up to 25 seconds and is
cancellable during serving/login. Lost ownership aborts auth requests and blocks
further credential writes. This is an advisory heartbeat lock, not transactional
fencing against an arbitrarily suspended process.

Login locks registration setup and final persistence, but releases the lock during
browser consent. If credentials change meanwhile (another login, logout, or refresh),
the pending login asks you to retry rather than overwrite them. Logout uses the same
lock, so an active refresh finishes before deletion and cannot restore the removed
grant. Running gateways read the current credential snapshot for subsequent requests
and can adopt a later login with the same upstream/issuer/resource binding. Logout
does not cancel requests already sent or revoke tokens upstream. Session deletion at
shutdown is skipped if authorization is no longer available or shutdown cancellation
prevents authenticating the deletion request.

Refreshes are shared within each process. Rotated tokens are saved before
being used; a failed refresh or save stops further refresh attempts for that unchanged
credential snapshot in that process. A newly saved grant permits recovery.
Post-exchange credential writes that reject instead of returning a failure also block
that snapshot, including on replacement connections; the original exception stays host-side.
Remote rotation and local persistence are not transactional: interrupted/lost
responses can require reauthorization. Auth network requests have a 15-second
budget covering DNS and HTTP; validation-only endpoint lookups have the same bound.
These budgets are separate from the five-second MCP handshake and credential-lock waits.
Network timeouts before an exchange permit retry; caller cancellation remains cancellation,
and an uncertain exchange is never retried with unchanged credentials.
Requests use HTTPS except for loopback development and reject HTTP redirects.
Remote discovery cannot delegate requests to loopback/private/reserved addresses.
An explicitly configured loopback upstream permits loopback development endpoints;
an explicitly configured private IP permits endpoints at that same origin. Private
hostnames and cross-origin private authorization servers are rejected. DNS answers
are checked in full and each request is pinned to one approved address (IPv4 preferred),
preserving the original HTTP Host and TLS certificate identity. Failed exchanges
are not retried at alternate addresses. Browser authorization endpoints are checked
before opening, but the external browser owns its own subsequent DNS resolution.
Tool payloads and aggregate memory remain subject to the existing documented limitations.

`logout` removes local credentials and registration details; it does **not** revoke
the upstream grant. Revoke access in the provider's settings when necessary.
The Notion smoke example performs read-only discovery/search and optional fetch,
validating input schemas, provider response shapes, and expected page identity.
`--expect` also checks a text marker; `--runs` accepts 1–20 sequential iterations.
It prints JSON-line validation/timing summaries rather than page bodies, stops on
failure with a nonzero exit, and checks natural gateway exit after EOF. Its tool
names target Notion's current user-authorized server, not older workspace-owned
catalogs. The repository's `docs/archive/investigations.md` retains dated live-run
evidence, not a fresh provider-compatibility or performance guarantee.

Automated OAuth tests use synthetic servers and isolated stores. A live macOS
login and subsequent Notion search/fetch workflow have been verified. Live runs
require explicit interactive authorization and are not part of the default suite;
`notion-example.test.ts` checks the runner against synthetic provider responses.

The implementation follows the login workflow: prepare an authorization attempt,
present its URL, await completion, then conditionally save the grant under a short lock.
`src/auth/login.ts` owns that workflow and logout. Following Tern's loopback pattern,
`loopback.ts` checks the method, host, path, and state, then accepts one callback URL;
replays receive HTTP 409. `login.ts` owns the shared deadline; `oauth.ts` owns registered-port reuse and
callback interpretation (including code/error and issuer validation), using SDK
helpers for discovery, registration, and code exchange. The listener acknowledges
receipt, not successful authorization; malformed OAuth responses fail the attempt
before token exchange.
The attempt retains its PKCE verifier and shares one code exchange across completion
calls. Rejected client registrations are removed only if the stored snapshot still
matches the attempt, so another login can register again without deleting a newer grant.
`session.ts` owns noninteractive refresh coordination, `credentials.ts` owns snapshot
validation and token normalization, and `file-store.ts` implements private file-backed
persistence. These module paths are internal.

## Programmatic API

```ts
import { Configuration, Gateway } from "codemode-mcp-gateway";

await using gateway = new Gateway(
  Configuration.parse({
    mcp: { servers: { math: { type: "local", command: ["bun", "mcp-server.ts"] } } },
  }),
  "/path/to/config-directory",
);
await gateway.start();
const server = gateway.createServer();
// Connect an application-owned transport and serve requests within this scope.
```

Construct `new Gateway(Configuration.parse(input), directory,
options?)`, call `await gateway.start()`, and attach `gateway.createServer()` to an
application-owned transport. `start()` waits for initial attempts; expected upstream
failures are available from `gateway.status()`. Creating an MCP server before that
promise settles exposes connecting statuses. `options.onStatus` receives updates;
`options.onToolException` receives private tool exceptions while executions run;
`gateway.failure` resolves with unexpected background infrastructure failures, which
are also surfaced by `close()`. Close/dispose the gateway to stop maintenance,
abort executions, and release all connections. Importing the package starts none
of these activities. `ConfigurationInput` describes the JSON input; `Configuration`
is the validated form with defaults applied. Local and remote entries keep the same shape.

`gateway.listTools()` returns a `ToolList` snapshot of current upstream names,
descriptions, and server statuses without making requests or executing tools. It
does not include discovery helpers or input schemas. The HTTP host exposes this
snapshot through authenticated `GET /tools`, without creating an MCP session.

The public entry also exports `Configuration`, `resolveHeaders`, and
`serve(configurationPath)`. `serve` owns the complete stdio
process lifetime, including configuration loading and shutdown listeners. Importing
the package alone starts neither path. Public signatures ship in `dist/index.d.ts`.

`GatewayHttpServer.listen(gateway, { port, bearerToken })` borrows the gateway and
owns only its HTTP listener and MCP sessions. The caller supplies the persistent
token directly; programmatic hosting does not read `GW_HTTP_TOKEN`. Closing the
HTTP host leaves its borrowed gateway usable. The retired `serviceKey` and
`configurationId` options are no longer accepted.

`login(path, options?)` and `logout(path, options?)` return explicit `AuthResult`
values for expected authorization/storage failures. Configuration, infrastructure,
and cleanup failures may reject, including `AuthorizationError` when releasing a
credential lock fails. `serve(path, options?)` accepts the same
host-owned scoped credential-store factory and lock-directory override, plus an
optional `signal` to cancel startup or serving. Active serving awaits cleanup. The CLI
uses private credential files. A custom store must preserve credential bindings and durable,
atomic snapshot replacement, including for readers outside the lock. The exported
`Credentials` schema validates stored snapshots; custom stores must also validate
the connection binding. All processes
sharing credentials must use the same lock directory. Imports perform no credential reads, browser launches, or
process-listener registration.

Serving reports expected authorization failures per upstream. `AuthorizationError.failure`
carries a controlled kind/message and optional private cause;
do not serialize causes into MCP responses or diagnostic logs.

## How it works

```text
configuration -> independent upstreams -> catalog/status revisions
  -> combined tool/discovery snapshots -> one fixed-policy CodeExecutor -> MCP execute server

agent code -> worker/guest -> host tool adapter -> upstream MCP
           <- returned value/error text, or saved-output preview and path
```

Qualified upstream names cannot overwrite `searchTools` or `describeTool`.
The MCP adapter borrows an executor; this package selects QuickJS
and describes its actual environment to the agent.

For stdio, EOF, SIGINT, and SIGTERM cancel active executions and await worker cleanup before
closing the upstream. Stdio shutdown observes the child's actual close event;
HTTP shutdown requests session deletion when supported, with a 5-second DELETE
request timeout. The agent-facing transport opens during upstream setup, so EOF
can also cancel a stalled handshake or discovery.

### Source layout

The two transport directions are separate: `http/` and `stdio/` accept MCP clients;
`upstream/` connects outward to MCP servers using either stdio or HTTP.

```text
MCP clients → http/ or stdio/ → Gateway → upstream/ → MCP servers
```

All paths below are relative to this package's `src/` directory:

```text
cli.ts                 Executable entry; no CLI startup from index.ts
index.ts               Public programmatic API
gateway.ts             Shared connections, catalog snapshots, and executor
catalog.ts             Discovery bindings for a fixed catalog/status revision
tool-list.ts           Shared tool metadata contract; no HTTP or formatting
config.ts              Configuration parsing and resolution
output.ts              Session-owned output files
instructions.ts        Guest-facing execution instructions
diagnostics.ts         Host diagnostic projections
errors.ts              Controlled public gateway errors

cli/
  main.ts              Command dispatch, signals, and exit codes
  command.ts           Arguments and focused help
  presentation.ts      Terminal and pipe output primitives
  status.ts            Status/probe presentation
  tool-list.ts         Tool pagination and presentation
  setup.ts             Explicit first-run preparation

stdio/
  serve.ts             Client-owned process, MCP transport, and EOF cleanup

http/
  serve.ts             Foreground HTTP process lifetime
  server.ts            Listener, routes, authentication, and MCP sessions
  client.ts            Read-only authenticated status/tool-list requests
  protocol.ts          HTTP management status contract
  token.ts             Private bearer token creation and resolution

upstream/
  upstream.ts          Credential selection, availability, recovery, and leases
  connection.ts        One outgoing transport/OAuth session and its cleanup

auth/                  Upstream OAuth, credential stores, and login/logout

observability/
  events.ts            Typed metadata-only event contracts and severity
  logger.ts            Local structured logger and level filtering
  presentation.ts      JSON/terminal rendering of the same records
  config.ts            Logging environment validation
  execution.ts         Execution-local correlation, outcome logs, and call spans
  telemetry.ts         Owned metrics/traces providers; no global instrumentation
  telemetry-config.ts  Explicit OTLP opt-in and safe environment validation
```

Gateway startup and recovery passes are serialized, so no separate connection-attempt
registry is needed. The serving modules own process lifetime, not process supervision,
client provisioning, or token creation. HTTP response validation is separate from CLI
presentation; shared tool metadata does not depend on either. Public imports still
use the package root, not these internal paths.

`bun run build` emits `dist/cli.js` with a Bun shebang. After installing a packed
build, invoke it as `gw serve --transport stdio --config configuration.json` for stdio; dependencies are not bundled.
`bun run build:standalone` additionally emits the self-contained application at
the repository's `dist/gw`; version metadata and the worker entry are embedded.
The build wraps QuickJS's Emscripten loaders to supply embedded WASM bytes through
their documented `wasmBinary` option, while retaining the patched SDK build.

The Notion runner and metadata observer accept `--gateway <installed-gw-path>`
to launch that executable instead of the source CLI. The repository's
`docs/installed-validation.md` describes local tarball checks and saved-credential
reuse. Examples and source references above are checkout-only, not shipped internals.

## Current scope

Named upstreams with partial availability and hot credential recovery. Agent-facing
transport defaults to authenticated loopback Streamable HTTP, with explicit client-owned stdio.
Users choose how to install and supervise HTTP processes and
configure its clients. There is no model loop, remote network hosting, or Node support. Cancellation cannot roll back
upstream side effects. A Notion validation run and sequential execution baseline
are recorded; those finite runs do not establish production stability. Aggregate/payload
resource hardening and sustained ordinary-provider testing remain future work. Local OAuth serves one
OS user; team-member identity, hosted authentication, and shared credential management
are not implemented.

## Development

From the workspace root:

```sh
bun run --cwd packages/gateway test
bun run --cwd packages/gateway check
bun run verify:standalone
```

This package owns configuration, composition, CLI, end-to-end gateway, and
stdio/HTTP shutdown tests in a flat `tests/` directory, grouped by public subject.
`gateway-discovery.test.ts`, `gateway-lifecycle.test.ts`, `gateway-recovery.test.ts`,
and `gateway-credential-races.test.ts` separate discovery/partial availability,
startup/shutdown, recovery, and retired-credential races without sharing scenario logic.
`gateway-network.test.ts` covers OAuth network-deadline recovery; `gateway-persistence.test.ts`
covers rejected credential writes and recovery after a new login.
`login.test.ts`, `login-callback.test.ts`, `login-network.test.ts`, and `logout.test.ts` specify authorization
workflows through public login/logout; `credentials.test.ts` specifies the exported schema.
`authorization.test.ts` exercises running gateways through real SDK clients.
Only `credential-ownership.test.ts` retains internal session/lease probes, for
out-of-order store completions, persistence publication, and compromised/crashed
lock ownership that the public serving API cannot expose precisely.
`credential-store.test.ts` exercises real file permissions, symlinks, and atomic replacement
through the exported factory; `gateway-file-credentials.test.ts` verifies default paths and
login/refresh/restart/logout across real processes with synthetic credentials.
Its helpers and upstream fixtures are package-local. Packed-consumer fixtures additionally verify the installed API
and `gw` executable through the root distribution checks.
Repository testing conventions live in `docs/testing.md`, not the shipped package.
