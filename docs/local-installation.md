# Local standalone installation

The product/MCP name is **codemode-mcp-gateway**; the executable is **`gw`**.
Library APIs use the scoped package imports:

```ts
import { CodeExecutor } from "@codemode-mcp-gateway/codemode";
import { createMcpCatalog } from "@codemode-mcp-gateway/mcp";
import { Gateway } from "codemode-mcp-gateway";
```

This is a private local installation, not a release or a single-file native binary.
It requires Bun 1.4.3 and runs installed ESM, its worker, bundled SDK JavaScript,
and external dependencies. One persistent macOS LaunchAgent owns the gateway;
Codex and Claude connect directly using Streamable HTTP MCP. No bridge is used.

## Build, verify, and activate

```sh
bun run install:local
gw service install
gw service status --json
```

The installer copies current tracked and nonignored untracked source to a disposable
directory, installs the frozen lockfile with scripts disabled, explicitly builds,
and packs all three packages. It installs the tarballs with local overrides into:

```text
~/.local/share/codemode-mcp-gateway/installs/<revision>-<timestamp>/
```

The candidate archives pass the existing isolated-consumer checks, including
declarations, real worker execution/cancellation, MCP composition, and the installed
`gw` executable. Only then does an atomic symlink replacement activate `current`.
The build installer never restarts clients or publishes anything. `gw service install`
separately registers/starts the user LaunchAgent. Earlier builds stay
available for running clients and rollback. Source/build scratch files are removed;
the checkout's `dist/` is not needed at runtime or populated by this command.
`installation.json` records the source revision, dirty-tree flag, Bun version, and
install time; dirty source is included rather than silently installing old HEAD.

The personal dotfiles repository manages `~/.local/bin/gw`, which invokes Bun and
`current/node_modules/codemode-mcp-gateway/dist/cli.js`. The installer itself does not
overwrite a user's launcher, configuration, or credentials. This is not `bun link`:
subsequent source edits do not change an installed gateway until explicitly rebuilt.

## Configuration and clients

Default configuration is now `~/.config/codemode-mcp-gateway/config.json`, or
`$XDG_CONFIG_HOME/codemode-mcp-gateway/config.json`. Explicit `--config` still wins.
This replaces the old `cmg` CLI/default config path; library package names,
credential identity, and credential-lock storage are unchanged. Existing configs
can still be selected explicitly; they are not deleted or silently migrated.

Personal dotfiles configure `service.port: 4791`, New Relic, Metabase, Notion, and Jira (via Atlassian),
with no gateway tool allowlist. Provider-side OAuth grants still govern access.
New Relic and Metabase request their prior read/query scopes. Atlassian MCP can
advertise non-Jira tools as well. No old OAuth credentials are copied.

Codex's private configuration and Claude Code's user MCP registration use:

```sh
http://127.0.0.1:4791/mcp
```

Both use the MCP server name `codemode-mcp-gateway`. Neither launches a server or
bridge process. OpenCode's direct MCP settings are unchanged. Start the gateway:

```sh
gw serve
```

This automatically registers installed Codex/Claude clients with native HTTP
authentication. Launch plain `codex` or `claude`; no setup script, Python, dotfiles,
wrapper, or token environment variable is required. `gw serve` stays in the
foreground; use `gw service install` instead for login startup and crash recovery.
Upstream definitions still come from the gateway configuration; no personal
providers are silently added. Sign in explicitly, one provider at a time:

```sh
gw check --json
gw login --server newrelic
gw login --server metabase
gw login --server notion
gw login --server jira
gw doctor --json
```

Login needs interactive consent. A configured/connected local MCP server does not
mean its upstreams are authenticated. Missing grants yield `needs-auth`; other
upstreams remain usable. Servers requiring unsupported OAuth registration methods
must remain explicitly blocked, not worked around by copying credentials.

## Updating and rollback

Run `bun run install:local`, then `gw service restart`. To roll back, stop the service,
repoint `current` to a verified prior service-capable `installs/<id>` symlink target,
then start it. Pre-service stdio-only snapshots are not service rollback targets.
Never remove a build still used by the service. Updating does not replay interrupted
scripts. No automatic update, pruning, global package install, or publication occurs.

## Service lifetime, security, and clients

`gw serve` is the foreground HTTP host used by launchd. `gw` alone shows help;
`gw serve --stdio` is explicit direct-mode compatibility. Service install/start/stop/
restart/status/uninstall need no administrator privileges. Install starts at login;
crashes/nonzero exits restart, clean stops do not. Stop/uninstall work without a
valid provider config or credentials and never delete upstream OAuth records.

The listener is restricted to `127.0.0.1`; Host and Origin validation supplement
mandatory bearer authentication. Only `GET /health` is unauthenticated and returns
`ok`. `/status` and every MCP method require authentication. `/status` reports a live
instance ID, process ID, configuration identity, sessions, actual upstream status,
and client registration results from startup, never tokens. Service readiness checks
match the endpoint PID against the owning launchd job and selected configuration,
and wait for registration attempts to finish. Readiness does not mean every client
or provider succeeded: inspect the separate `clients` and `upstreams` results.

The stable local credential is in
`$XDG_STATE_HOME/codemode-mcp-gateway/service/auth.json` (default
`~/.local/state/codemode-mcp-gateway/service/auth.json`), with a 0700 directory and
0600 file. Missing credentials are created; invalid, symlinked, or nonprivate files
are refused, never silently rotated. This local token is separate from provider
OAuth in the OS store. The LaunchAgent and tracked client configs contain no secret.
Logs are private files beside the credential; `gw service status --json` is safe to inspect.

`gw serve` provisions Codex's native `http_headers.Authorization`
and Claude's native `headers.Authorization`. These literal credentials live only in
private 0600 `~/.codex/config.toml` and `~/.claude.json`, never in tracked files or
command arguments. It respects `CODEX_HOME` and `CLAUDE_CONFIG_DIR`; the latter
places Claude's user registration in `$CLAUDE_CONFIG_DIR/.claude.json`. Existing
client configs/directories or executables identify installed clients. Missing clients
are reported as `not-installed`, without creating their config directories.

The gateway updates only its own registration, preserving unrelated preferences,
servers, account state, and compatible tool policies/timeouts. TOML edits use parser
source ranges to retain unrelated comments/formatting/multiline strings; Bun supplies
semantic validation and serialization. No-op starts leave config files untouched.
Changed files use private temporary files and atomic replacement. A short-lived lock
serializes gateway writers; an observed concurrent edit aborts that update. Native
clients do not share this lock, so this is not a cross-application transaction, and
the two client updates are not atomic as a pair.

Symlinked configs/directories and destinations inside Git checkouts are refused;
malformed or unwritable configs are reported per client without replacement. Other
clients and the gateway can remain usable. Repair the reported problem and rerun
`gw serve`. The startup output reports the latest attempt; the daemon's `/status`
client results record its own startup attempt. Never put a native credential in a
tracked config. Personal dotfiles may seed secret-free preferences separately, but
the gateway never depends on them.

If the port is occupied, native configs are not changed unless authenticated status
identifies the same gateway configuration/directory. In that case `gw serve`
refreshes registrations and exits without another daemon or upstream connections.
Different/older gateway configurations require an explicit service restart. Unrelated
listeners are never killed. `gw service start` also refreshes an already-ready service's
client registrations; install/restart run the same `gw serve` startup path.

Run plain `claude` or `codex`. GUI clients reading these same configs
use the same headers without shell inheritance; GUI interaction itself was not tested.
Already-running clients must reload/restart. Later service starts synchronize changed
ports/tokens without a separate setup command; normal restarts do not rotate the token.
OpenCode's configuration and environment are unchanged. Importing the library,
programmatic HTTP hosting, and explicit stdio serving never modify native client configs.

Each HTTP session owns its spills. DELETE closes only that session, cancels/drains
its work, and removes its output. Event streams and pending requests keep it alive;
after the last stream/request disconnects, a 60-second grace retires abandoned
sessions. There is no per-file TTL, global disk quota, crash sweep, or replay. A
client can reconnect with a new session after a service restart, but interrupted
scripts must not be replayed automatically. Closing clients never stops the daemon.

The programmatic `GatewayHttpServer.listen(gateway, options)` borrows a gateway,
returns a validated listen result, and owns only its listener/sessions. `close()`
drains those sessions without disposing the borrowed gateway. The daemon owns both.

## Earlier stdio installation validation: 2026-10-16

Source was `6202446` plus the uncommitted CLI/install changes, using Bun 1.4.3.
`bun run check` passed 656 tests, build/typecheck/lint/format, and packed consumers;
`bun run example` passed. `bun run install:local` built in scratch, verified the
candidate archives with `--archives`, and activated a versioned local install.

Codex CLI 0.162.1's native app-server discovered `execute` through the managed
registration and returned `42` from `return 42;`. The probe used an ephemeral,
read-only thread, no model turn, and disabled other MCP entries only for that probe
process; it exited with code zero. Claude Code 2.1.301's own `mcp get` reported the
user-scoped server connected. Neither check used a model or invoked upstream tools.

The default four-provider config passed `gw check --json`. `gw doctor --json`
reported Notion connected with 57 tools using an existing credential in this
gateway's own OS store; New Relic, Metabase, and Jira reported `needs-auth` and still
require explicit login. No old credentials were copied. Codex and Claude's old
My CodeMode registrations and managed launchers were removed; old source/OAuth
state and Keychain entries were retained. OpenCode's config was checked byte-for-byte
unchanged. Dotfiles shell/TOML/JSON checks and a Stow restow simulation passed.

These are local installation/interop checks, not live-provider workflow validation,
cross-client shared-process behavior, or a release approval.

## Shared HTTP service validation: 2026-10-16

Against `650a368` plus the uncommitted HTTP/service changes, Bun 1.4.3 on macOS arm64:

- `bun run check` passed **680 tests**, build/typecheck/lint/format, and isolated
  installed consumers. `bun run example` passed. The rebuilt install's candidate
  tarballs also passed the installer verification before activation.
- `gw service install` registered and started the user LaunchAgent. Its generated
  plist passed `plutil -lint`; credentials, plist, and log files were owner-only.
- Idempotent start retained the PID. Controlled restart and stop/start produced new
  ready instances. A deliberate SIGKILL of the verified owned daemon was recovered
  by launchd. The local credential bytes stayed unchanged throughout.
- Native Codex 0.162.1 discovered `execute` and returned `42` through the configured
  HTTP URL using an ephemeral, read-only app-server thread. While that MCP session
  remained open, native Claude Code 2.1.301 reported its same-URL HTTP connection
  connected. After both clients exited, the same daemon PID/instance remained ready.
- Both probes used the actual client environment helper. No model turn or real
  upstream tool invocation was used. This initial helper-based setup was subsequently
  replaced by native private headers; see below.
- HTTP tests separately verify gated caller cancellation without affecting another
  client, session-specific spill cleanup, abandoned-session retirement, rejected
  bearer/Origin/Host values, optional pre-initialize probes, occupied ports, and the
  borrowed gateway's continued usability after HTTP host close. Foreground CLI tests
  verify EOF-independent lifetime and refusal of malformed, nonprivate, or symlinked
  credentials without replacing them.

Operator status still reports Notion connected and New Relic, Metabase, and Jira
`needs-auth`; those provider grants require the user's explicit login. Daemon readiness
does not imply provider authorization. The earlier 30-minute synthetic soak was not
rerun against this service. These finite checks do not establish production stability,
indefinite memory bounds, crash-time cleanup, or side-effect rollback.

### Native headers without a launch helper

The subsequent credential-provisioning correction removed the shell helper and
`codex`/`claude` wrapper functions. Direct native executables were checked with
`GW_SERVICE_TOKEN` absent: Codex's ephemeral read-only app-server discovered `execute`
and returned `42`; Claude Code's `mcp get` reported connected while Codex's session
was open. No model call or upstream tool was used. The temporary Python setup command
and its seven dotfiles tests were subsequently replaced by gateway-owned automatic
registration and process/packed-consumer coverage. Client paths in process tests are
isolated through HOME, CODEX_HOME, CLAUDE_CONFIG_DIR, and XDG directories; no real
client configuration is used.

### Automatic registration on startup

The gateway-owned implementation passed `bun run check`: **697 tests** plus
build/typecheck/lint/format and isolated packed consumers. `bun run example` passed.
The added installed-service consumer starts `gw serve` with isolated empty client
configs and an empty PATH, checks private native headers, executes `return 42;`
over HTTP, and verifies repeated serving reuses the original daemon without
rewriting correct registrations. No dotfiles or external setup runtime is involved.

After refreshing the private installation, `gw service install` reported both native
registrations unchanged. Plain `gw serve` reused that instance. Direct native Codex
and Claude probes with `GW_SERVICE_TOKEN` absent connected simultaneously; Codex
returned `42`. Both exited without stopping the daemon; `gw service start` retained
its PID and refreshed registration. No model call or real upstream tool was used.
OpenCode remained byte-for-byte unchanged. These checks do not establish GUI
interaction behavior, indefinite stability, or cross-application transactional writes.
