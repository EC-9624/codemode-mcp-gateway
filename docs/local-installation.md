# Local deployment

The product/MCP name is **codemode-mcp-gateway**; the executable is **`gw`**.
The standalone executable includes Bun and its application dependencies. Building
or running source/packages requires Bun **1.4.3**. Installation, process supervision,
upstream definitions, and MCP client configuration are user responsibilities.
There is no provisioning installer, updater, rollback manager, or `gw service` command.
Nothing is published; build the native executable from this checkout for now.

## Build and install the application

```sh
bun install --frozen-lockfile --ignore-scripts
bun run install:gw
"$HOME/.local/bin/gw" --version
```

`install:gw` runs the existing standalone build and installs only its executable
at `~/.local/bin/gw` with mode 0755. It does not install dependencies, run setup,
edit shell/client files, or start/register a service. Dependencies must already
be installed. Existing files or symlinks are refused before building unless
`--force` is supplied; directories and special files are always refused. A failed
build leaves the installed executable untouched. A complete staged binary replaces
the directory entry, never the contents of an existing inode or symlink target.
The temporary installation directory is removed on completion or failure.

For updates, stop the gateway yourself, then run `bun run install:gw --force`
and restart it. No automatic restart or rollback is provided. For build-only use,
run `bun run build:standalone` and deploy `dist/gw` yourself.

Ensure `~/.local/bin` is on PATH yourself; the script warns rather than editing
your shell configuration. The installation script supports macOS/Linux and has
been tested on macOS arm64. Run builds serially within one checkout.
This is one executable for the build
machine's platform, not a universal binary. It includes the gateway and internal
libraries, Bun runtime, worker entry, version metadata, and QuickJS WASM assets.
No checkout, `node_modules`, sibling `package.json`, or external Bun executable is
needed at runtime. Configured local upstreams can still require their own tools
and runtimes. Automated standalone execution checks verify the host platform only.

The standalone executable deliberately does not auto-load cwd `.env` or
`bunfig.toml` files. Inject environment settings through your shell or supervisor
explicitly. Standalone packaging does not add remote network hosting; the listener
remains loopback-only. OAuth uses private credential files and explicit interactive
login; serving reads and refreshes saved grants without Keychain prompts.

## Prepare gateway files explicitly

```sh
gw setup --transport http
# Edit the displayed configuration to add your upstream MCP servers.
gw config check
gw auth login notion  # Only if you configured an OAuth server named notion.
gw probe              # Optional fresh connectivity check; closes its connections.
gw serve              # Default HTTP service; keep this terminal running.
```

Default `setup` prepares only a mode-0600 starter configuration at
`~/.config/codemode-mcp-gateway/config.json`. Its empty `mcp.servers` object deliberately
does not validate as runnable until you add upstream definitions. It does not read
or create HTTP credentials, even if HTTP environment settings or saved tokens are invalid.

HTTP clients connect to `http://127.0.0.1:4791/mcp` with the saved gateway token.
See [Configure clients yourself](#configure-clients-yourself) below for Codex and
Claude Code configuration. `gw serve` defaults to HTTP and must remain running.

For optional client-owned stdio instead, configure your client to launch:

```json
{
  "command": "/absolute/path/to/gw",
  "args": ["serve", "--transport", "stdio"]
}
```

`gw serve --transport stdio` gives each client launch an independent gateway,
executor budget, and upstream connections. It requires no gateway bearer token or
listening port. Stdout is exclusively MCP; diagnostics go to stderr. Closing stdin
requests cleanup, as do SIGINT/SIGTERM. Saved upstream OAuth credentials are still
required and can be shared by independent gateway processes.

For explicit HTTP use, `gw setup --transport http` creates only missing gateway files:

- `~/.config/codemode-mcp-gateway/config.json`: a mode-0600 starter with an empty
  `mcp.servers` object. Add upstream definitions yourself; this starter deliberately
  does not validate as runnable configuration until at least one server is defined.
- `~/.local/state/codemode-mcp-gateway/token`: 32 random bytes encoded as hex,
  stored with mode 0600 in an owned, non-symlinked mode-0700 directory.

It never overwrites existing configuration or tokens, imports upstream definitions,
changes client files, authorizes providers, installs upstream dependencies, or
starts/registers a process. Rerunning it validates/reuses the credential rather
than rotating it. Existing malformed configuration is preserved and reported as
not ready. Exit 0 means file preparation succeeded, not that MCP is ready.
Preparation is not a transaction across the two files: if a later step fails,
rerun setup to reuse already-created files safely. Concurrent setups publish one
complete token without replacing each other's credentials.

Configuration resolves from `--config <path>` / `-c`, then
`$XDG_CONFIG_HOME/codemode-mcp-gateway/config.json`, otherwise
`~/.config/codemode-mcp-gateway/config.json`. Local `cwd` defaults to the configuration
directory; relative `cwd` resolves from there, and command arguments pass through
unchanged. Token storage honors `XDG_STATE_HOME`, otherwise
`~/.local/state`; it is independent of the config path. Empty XDG variables use
the home fallback; relative paths are rejected. `service.port` defaults to 4791.
Use the same `--config` path for setup, config check, auth login, and serve when choosing a nondefault
configuration. `gw token show` needs no configuration and accepts no `--config`.
Legacy positional paths and command aliases are not supported. Server selection
is positional: `gw probe notion`, `gw auth login notion`, or `gw status notion`.
Put options first and use `-- <server>` for leading-hyphen server names.

To update, stop the gateway, replace the executable, and start it again. The files
above and upstream credential files are separate from the binary and remain intact.
Keep a previous binary yourself if you want rollback. No version-directory manager
or automatic process restart is provided.

## Source and package alternatives

```sh
bun run gw setup
bun run gw serve --config packages/gateway/examples/local.json
```

`bun run build` retains ordinary compiled ESM/package output; unlike `dist/gw`,
`bun packages/gateway/dist/cli.js serve` needs Bun and installed dependencies.
The reusable libraries remain independently packable; see
[external consumers](installed-validation.md#prepare-an-external-consumer).
`bun run verify:packages` verifies those tarballs, while `bun run verify:standalone`
checks the application in an isolated HOME with an empty PATH. The clean-source
check also exercises `install:gw` in an isolated HOME, then removes the disposable
build/dependency tree before running the installed executable.

## HTTP authentication

HTTP is the default and loopback-only; remote network hosting is not implemented.
Run `gw setup --transport http`, configure your upstreams, and start
`gw serve --transport http`. `gw status [server]` reads only that running process;
it never opens upstream connections or inspects a stdio process.

`gw serve --transport http` and `gw status` use an explicitly supplied `GW_HTTP_TOKEN` first,
otherwise the private setup-created token. An empty or invalid environment override
is an error, not a request to fall back. Overrides must contain 32–256 letters,
digits, underscores, or hyphens. Generate a high-entropy value if managing one
yourself and supply it unchanged after restarts. Environment-managed setup validates
the supplied value but does not persist it or create a competing credential.

Serving and diagnostics never provision credentials or display them. `gw setup --transport http`
reports only the token-file path. **`gw token show` explicitly prints the effective
secret to stdout** for manual client registration; do not send its output to logs
or commit it. The token is never accepted as a CLI argument or gateway JSON setting.
Keep token files, client headers, and process environments private and outside Git.
Symlinked, nonprivate, nonregular, or malformed stored-token files are refused, not
repaired or replaced automatically. The token directory must be owned by the user
with mode 0700, and the token file must be owned with mode 0600.

Clients send `Authorization: Bearer <your-token>` to
`http://127.0.0.1:4791/mcp`. This credential is unrelated to upstream OAuth tokens,
which are plaintext snapshots in `$XDG_STATE_HOME/codemode-mcp-gateway/credentials`
(default `~/.local/state/codemode-mcp-gateway/credentials`). OAuth files use mode 0600
in a mode-0700 directory; the application does not encrypt them. Initial authorization
still requires explicit login.

**Rotation is explicit:** replace the private token-file contents with a new valid
high-entropy value (retaining mode 0600), or change the environment override, then
restart the gateway and
update/reload clients. A restart alone does not revoke an unchanged token; a leaked
token remains usable until rotation. There is no hot rotation or overlap period.

The listener binds only `127.0.0.1`; mandatory bearer authentication is supplemented
by Host and Origin validation. `GET /health` returns unauthenticated liveness only.
`/status` and all MCP methods require the token. Status includes the process ID,
instance ID, uptime, session count, and observed upstream states—not credentials,
installation details, or client-registration outcomes.

Live status requests send the bearer token to the configured loopback port, reject
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

In private `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`), merge this entry:

```toml
[mcp_servers.codemode-mcp-gateway]
url = "http://127.0.0.1:4791/mcp"
http_headers = { Authorization = "Bearer <your-private-token>" }
```

### Claude Code

In private `~/.claude.json`, merge this into the existing user-level `mcpServers`
object without replacing unrelated entries:

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

`gw serve --transport http` stays in the foreground until SIGINT/SIGTERM or an infrastructure failure;
stdin EOF and closing an MCP client do not stop it. An occupied port fails without
probing, replacing, or adopting the owner, and before upstream connections start.
Choose an external supervisor if you need login startup or crash recovery.

Each HTTP session owns its output spills. DELETE cancels/drains that session and
removes its output without affecting other clients. Open requests/event streams
retain sessions; disconnected sessions receive a 60-second retirement grace.
Crashes can leave output behind. Scripts are never automatically replayed.

`gw probe [server]` explicitly opens and closes fresh upstream connections and
needs no gateway HTTP token. `gw status [server]` reads the running HTTP gateway
rather than starting another set. `gw tools list [server]` lists that process's
current tool catalog in a width-aware table of 50 names/descriptions. Select a server
to filter the list; use `--offset 50` for the next page (with or without a server) or `--all`
for a full listing. `--json` remains complete and cannot be combined with `--offset`
or `--all`. Listing never connects upstreams or executes tools. These commands never
change saved configuration. Restart an
older running gateway after updating the executable to enable tool listing.

Interactive `status` shows the gateway endpoint, PID, uptime, session count, and
upstream table. Tool listings do not repeat this overview; unavailable upstreams
produce brief stderr warnings. Piped tools are untruncated, headerless TSV (`name`,
`description`); piped status/probe records contain `upstream`, `state`, `tool count`,
and `public error message`. Tool pagination hints go to stderr when piped. JSON
stays complete, including service metadata for status. HTTP startup/state messages
are human-readable on terminal stderr; redirected HTTP and stdio events use structured
JSON lines with service/session/execution metadata. `GW_LOG_LEVEL` selects `debug`,
`info` (default), `warn`, or `error`. Logs do not export to a collector or include code,
arguments, results, or raw exception messages. See the package's structured logging
section for the data shape and inherited-upstream-stderr limitation.

Metrics/tracing is separately opt-in: set `OTEL_EXPORTER_OTLP_ENDPOINT` to an
OTLP/HTTP protobuf collector before `gw serve`. This exports execution/call timing,
connection health, capacity, and session counts—not logs or payloads. Per-signal
endpoints, headers, exporters, timeout limits, and ownership are documented in the
package's [metrics and traces](../packages/gateway/README.md#metrics-and-traces) section.

```sh
bun run gw auth login notion --config packages/gateway/examples/multi.json
bun run gw probe --config packages/gateway/examples/multi.json --json
gw tools list notion --json
```

Login remains explicit and interactive. Serving loads saved upstream credentials
and refreshes noninteractively. Missing grants yield `needs-auth`; other upstreams
remain usable. Logout removes local upstream credentials, not the provider grant.

`config check`, `probe`, `status`, and `tools list` accept `--json` for one result, including
operational failures. Argument errors go to stderr. Exit codes are 0 for success,
1 for operational failure, 2 for invalid arguments, 130 for SIGINT, and 143 for
SIGTERM after cleanup. `probe` fails when enabled upstreams cannot connect;
`status` and `tools list` succeed on retrieval, even if upstreams are degraded;
consult the returned server statuses for availability.
`gw help <command...>` and `<command> --help` show focused help without side effects.

## Migrating from gateway-managed installation

- Stop and unregister any previously installed launchd job using your OS tools
  before starting this build. The retired `gw service` commands are unavailable.
- Choose your executable path and run `gw setup --transport http`, or keep using an explicit
  persistent `GW_HTTP_TOKEN` override.
- Replace the old instance-derived bearer header in your clients with that token.
  Old service `auth.json` keys and native headers are not imported or migrated.
- Existing installations, launchd definitions, service credentials, and client
  settings are left untouched. Remove obsolete files yourself when no longer needed.
- Upstream OAuth identities still use server name and canonical URL. This build
  stores grants under `codemode-mcp-gateway/credentials` and locks under
  `codemode-mcp-gateway/locks`, both below the XDG state root. Old `cmg/locks` files
  are not reused. Stop old processes before switching builds.
- Run `gw auth login <server>` again for existing OAuth servers after switching
  from Keychain/libsecret storage. Old OS credentials are not imported, read, or deleted.

Historical validation of the retired installer, automatic registration, and OS
service commands is retained in [the archive](archive/deployment-validation.md),
not part of this installation workflow.
