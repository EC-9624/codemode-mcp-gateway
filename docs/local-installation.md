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
and external dependencies. Each MCP client launches its own stdio process.

## Build, verify, and activate

```sh
bun run install:local
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
The installer never restarts a client or publishes anything. Earlier installs stay
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

Personal dotfiles configure New Relic, Metabase, Notion, and Jira (via Atlassian),
with no gateway tool allowlist. Provider-side OAuth grants still govern access.
New Relic and Metabase request their prior read/query scopes. Atlassian MCP can
advertise non-Jira tools as well. No old OAuth credentials are copied.

Codex's managed configuration and Claude Code's user MCP registration launch:

```sh
/bin/sh -c 'exec "$HOME/.local/bin/gw"'
```

Both use the MCP server name `codemode-mcp-gateway`. OpenCode's direct MCP settings
are unchanged. Register Claude Code, if needed:

```sh
claude mcp add --scope user --transport stdio codemode-mcp-gateway -- \
  /bin/sh -c 'exec "$HOME/.local/bin/gw"'
```

Check configuration and sign in explicitly, one provider at a time:

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

Run `bun run install:local` for an explicit update, then restart client-owned gateway
processes. To roll back, stop those clients and repoint `current` to a verified prior
`installs/<id>` symlink target, then restart. Do not remove an installation still used
by running clients. No automatic update, pruning, global package install, or daemon
management is performed.

## Local validation: 2026-10-16

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
