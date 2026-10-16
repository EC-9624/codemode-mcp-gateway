# Local deployment

The product/MCP name is **codemode-mcp-gateway**; the executable is **`gw`**.
It requires Bun **1.4.3**. Installation, process supervision, and MCP client
configuration are user responsibilities. There is no custom installer, updater,
rollback manager, or `gw service` command. Nothing is published.

## Run from the checkout or a built package

```sh
bun install --frozen-lockfile --ignore-scripts
bun run gw check --config examples/multi.json --json
# Supply GW_HTTP_TOKEN from a private environment before HTTP serving.
bun run gw serve --config examples/multi.json
```

For compiled ESM and worker assets, run `bun run build`, then:

```sh
bun packages/gateway/dist/cli.js serve --config /absolute/path/to/config.json
```

The compiled CLI still requires its workspace/package dependencies; it is not a
standalone binary. For manually packed installations, see
[external consumers](installed-validation.md#prepare-an-external-consumer).
`bun run verify:packages` verifies built tarballs in disposable consumers without
installing a user service. No lifecycle hook or global package link is required.
Users choose their own deployment location, updates, rollback, and process supervisor.

Configuration resolves from `--config` or a positional path, then
`$XDG_CONFIG_HOME/codemode-mcp-gateway/config.json`, otherwise
`~/.config/codemode-mcp-gateway/config.json`. Relative upstream paths resolve from
the configuration directory. `service.port` defaults to 4791.

## HTTP authentication

Supply `GW_HTTP_TOKEN` to `gw serve` and live `gw doctor` commands. It must contain
32–256 letters, digits, underscores, or hyphens. Generate a high-entropy token once
(for example, 32 random bytes encoded as hex), keep it in your own secret manager
or private environment file, and supply the same value after each restart.
Do not generate a new token in every startup command.

The gateway does not generate, persist, migrate, or print the HTTP token. It does
not accept the token as a CLI argument or gateway JSON setting. Any environment
file is user-managed and should be private, outside Git, and readable only by its
owner. Restrict access to the process environment too.

Clients send `Authorization: Bearer <your-token>` to
`http://127.0.0.1:4791/mcp`. This credential is unrelated to upstream OAuth tokens,
which remain in the OS credential store and still require explicit login.

**Rotation is explicit:** change the supplied token, restart the gateway, and
update/reload clients. A restart alone does not revoke an unchanged token; a leaked
token remains usable until rotation. There is no hot rotation or overlap period.

The listener binds only `127.0.0.1`; mandatory bearer authentication is supplemented
by Host and Origin validation. `GET /health` returns unauthenticated liveness only.
`/status` and all MCP methods require the token. Status includes the process ID,
instance ID, uptime, session count, and observed upstream states—not credentials,
installation details, or client-registration outcomes.

Live doctor checks send the bearer token to the configured loopback port, reject
redirects, and validate response JSON. They do not use signed status proofs or
authenticate the server's identity. **A different local process owning that port
can capture the persistent token and impersonate MCP/status responses.** Host/Origin
checks do not authenticate a server. Trust the port owner, or use direct stdio
when this local-process threat is unacceptable.

## Configure clients yourself

The gateway never discovers installed clients or reads/edits their configuration.
Add the HTTP registration using your client's supported configuration mechanism.
The following values are placeholders, not usable credentials.

### Codex

In a private Codex `config.toml`:

```toml
[mcp_servers.codemode-mcp-gateway]
url = "http://127.0.0.1:4791/mcp"
http_headers = { Authorization = "Bearer <your-private-token>" }
```

### Claude Code

In your private user MCP configuration:

```json
{
  "mcpServers": {
    "codemode-mcp-gateway": {
      "type": "http",
      "url": "http://127.0.0.1:4791/mcp",
      "headers": { "Authorization": "Bearer <your-private-token>" }
    }
  }
}
```

Use the same token supplied to the gateway. Keep literal credentials out of tracked
files and protect the client configuration (for example, mode 0600). Use a client's
own secret mechanism instead when appropriate. Neither client needs a gateway
wrapper or bridge. Already-running clients may need to reload configuration.

## Lifetime and upstream authorization

`gw serve` stays in the foreground until SIGINT/SIGTERM or an infrastructure failure;
stdin EOF and closing an MCP client do not stop it. An occupied port fails without
probing, replacing, or adopting the owner, and before upstream connections start.
Choose an external supervisor if you need login startup or crash recovery.

Each HTTP session owns its output spills. DELETE cancels/drains that session and
removes its output without affecting other clients. Open requests/event streams
retain sessions; disconnected sessions receive a 60-second retirement grace.
Crashes can leave output behind. Scripts are never automatically replayed.

`gw serve --stdio` retains direct client-owned stdio and requires no gateway HTTP
token. `gw doctor --stdio` explicitly probes fresh upstream connections; ordinary
`gw doctor` reads the running HTTP gateway rather than starting another set.

```sh
bun run gw login --config examples/multi.json --server notion
bun run gw doctor --config examples/multi.json --json
```

Login remains explicit and interactive. Serving loads saved upstream credentials
and refreshes noninteractively. Missing grants yield `needs-auth`; other upstreams
remain usable. Logout removes local upstream credentials, not the provider grant.

## Migrating from gateway-managed installation

- Stop and unregister any previously installed launchd job using your OS tools
  before starting this build. The retired `gw service` commands are unavailable.
- Choose your deployment path and provide a persistent `GW_HTTP_TOKEN` explicitly.
- Replace the old instance-derived bearer header in your clients with that token.
  Old service `auth.json` keys and native headers are not imported or migrated.
- Existing installations, launchd definitions, service credentials, and client
  settings are left untouched. Remove obsolete files yourself when no longer needed.
- Upstream OAuth identities, stored grants, and lock locations are unchanged.

## Historical validation of retired deployment workflows

The following records describe earlier builds, not current installation instructions
or verification of the persistent-token workflow.

### Earlier stdio installation validation: 2026-10-16

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

### Shared HTTP service validation: 2026-10-16

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
