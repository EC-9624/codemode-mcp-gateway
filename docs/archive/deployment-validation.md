# Historical validation of retired deployment workflows

These records describe earlier builds, not current installation instructions or
verification of the persistent-token workflow. They were moved from the local
deployment guide without regenerating the measurements. Use
[current deployment](../local-installation.md) for supported behavior.

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
