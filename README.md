# codemode-mcp-gateway

**Connect your MCP servers once. Discover and compose their tools with JavaScript.**

codemode-mcp-gateway exposes one MCP tool, `execute`, instead of adding every upstream
tool schema to your agent's tool catalog. Agents discover tools on demand, inspect
their schemas, and write JavaScript to combine calls and return relevant results.

Use it with MCP clients such as Claude Code and Codex. The gateway handles tool
connections and execution—not models or agent loops.

**Status:** Working MVP, not a production-hardened sandbox. Build from source with
**Bun 1.4.3**.

## Quick start

### 1. Install

Requires **Bun 1.4.3**. Run from the repository root:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run install:gw
"$HOME/.local/bin/gw" --version
```

Add `~/.local/bin` to your `PATH` to use `gw` directly.

The standalone executable includes its runtime. Local upstream servers may still
require their own runtimes and dependencies. Builds target the current platform;
standalone verification currently covers macOS arm64.

### 2. Configure your MCP servers

Prepare the configuration and HTTP authentication token:

```sh
gw setup --transport http
```

Edit `~/.config/codemode-mcp-gateway/config.json`. For example, to connect Notion:

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

Validate the configuration and authorize access:

```sh
gw config check
gw auth login notion
```

Login is explicit and interactive. The running gateway uses saved credentials and
refreshes them noninteractively.

For a local MCP server, use a command instead:

```json
{
  "mcp": {
    "servers": {
      "my-server": {
        "type": "local",
        "command": ["bun", "/absolute/path/to/mcp-server.ts"]
      }
    }
  }
}
```

The local server must already exist and support MCP over stdio. Its working
directory defaults to the configuration directory. Local and remote servers can
coexist under `mcp.servers`.

Setup creates only missing gateway files. It does not configure clients, authorize
upstreams, or start a process.

### 3. Start the gateway

```sh
gw serve
```

Keep this terminal running. The default endpoint is:

```text
http://127.0.0.1:4791/mcp
```

In another terminal, check upstream readiness and browse tools:

```sh
gw status
gw tools list
gw tools list notion
```

Upstreams connect independently. Connected servers remain usable if another server
is unavailable.

### 4. Connect your agent

Retrieve your gateway token privately:

```sh
gw token show
```

Replace `<your-private-token>` below. **Never commit real tokens or copy them into
logs.** Gateway HTTP authentication is separate from upstream OAuth.

#### Claude Code

Merge this entry into the user-level `mcpServers` object in `~/.claude.json`,
preserving existing settings:

```json
{
  "mcpServers": {
    "codemode-mcp-gateway": {
      "type": "http",
      "url": "http://127.0.0.1:4791/mcp",
      "headers": {
        "Authorization": "Bearer <your-private-token>"
      }
    }
  }
}
```

#### Codex

Add this entry to `~/.codex/config.toml`, or `$CODEX_HOME/config.toml`:

```toml
[mcp_servers.codemode-mcp-gateway]
url = "http://127.0.0.1:4791/mcp"
http_headers = { Authorization = "Bearer <your-private-token>" }
startup_timeout_sec = 60
tool_timeout_sec = 60
```

Restart or reconnect your client after editing its configuration.

Both clients can share the running gateway. They do not launch it, and closing
either client does not stop it.

## Discover, inspect, call

Agents submit JavaScript to `execute({ code })`. Code runs as an async function
body, so top-level `await` and `return` work.

These examples use the math upstream from the [gateway examples](packages/gateway/examples/README.md).
Each snippet is a separate `execute` invocation—not a terminal command.

### Discover tools

```js
return await tools.searchTools({
  query: "add numbers",
  server: "math",
});
```

Search returns ranked name and description previews, pagination information, and
upstream availability. Full schemas are fetched separately.

### Inspect a schema

Use the exact qualified name returned by discovery:

```js
return await tools.describeTool({ name: "math.add" });
```

### Call the tool

After inspecting its schema:

```js
const response = await tools["math.add"]({ a: 2, b: 3 });

if (response.isError) {
  return response.content;
}

return response.structuredContent.sum;
```

The result is `5`.

Complete upstream MCP responses are available inside the script. Check `isError`
explicitly: an upstream tool error is returned data, not automatically a thrown
JavaScript exception.

### Compose calls

Use ordinary JavaScript to combine independent requests and select the result you
need:

```js
const responses = await Promise.all([
  tools["math.add"]({ a: 2, b: 3 }),
  tools["math.add"]({ a: 10, b: 20 }),
]);

return responses.map((response) => {
  if (response.isError) {
    return { error: response.content };
  }

  return { sum: response.structuredContent.sum };
});
```

## CLI examples

```sh
# Validate configuration without connecting
gw config check

# Test fresh upstream connections, then close them
gw probe
gw probe notion

# Inspect the running HTTP gateway
gw status
gw status --json

# Browse its current tool catalog
gw tools list
gw tools list notion
gw tools list notion --offset 50
gw tools list --all
gw tools list notion --json

# Authorize an OAuth upstream
gw auth login notion

# Get focused help
gw help
gw help auth login
```

`status` and `tools list` query the running HTTP gateway. `probe` opens separate,
temporary upstream connections.

Use `--config /path/to/config.json` to select another configuration. Restart the
gateway after changing upstream definitions.

See the [gateway guide](packages/gateway/README.md) for full configuration and
command details.

## Client-owned stdio

If you prefer your client to launch its own gateway, configure a stdio command
instead of an HTTP endpoint:

```json
{
  "command": "/absolute/path/to/gw",
  "args": ["serve", "--transport", "stdio"]
}
```

Each launch owns separate upstream connections and execution limits. No gateway
HTTP token or listening port is needed. Saved upstream credentials are still
required where applicable.

For a nondefault configuration, append `"--config", "/absolute/path/to/config.json"`
to `args`.

## How it works

```text
MCP client
    │
    │ execute({ code })
    ▼
Gateway
    ├── Fresh worker + QuickJS VM
    │       │
    │       └── Tool calls over a JSON bridge
    │                   │
    └── Host adapters ──┴── Upstream MCP servers
    │
    ▼
Returned value or error text
```

Each execution runs in a fresh QuickJS VM with resource limits. Scripts have no
direct access to host filesystem, network, or process APIs. External actions go
through configured host tools.

The host owns upstream connections and credentials. Each execution receives a
snapshot of available tool bindings; an HTTP gateway shares its executor and
upstream connections across client sessions.

### Results and large output

Agent-facing responses contain text: strings are returned directly, and other
values are serialized as JSON.

Above **40,000 UTF-8 bytes**, the gateway returns a preview and a private local path
to the full output. Clients can read that file with their own file or shell tools
when they share the gateway's filesystem. Files are temporary and tied to the MCP
session.

See the [execution reference](docs/reference.md) for output and lifecycle details.

### Execution boundaries

- Tools retain the permissions of their upstream connections.
- Cancellation cannot undo upstream side effects.
- Failed scripts are not automatically replayed.
- Guest memory and execution limits do not cap all host work or upstream payload
  allocations.
- HTTP serving is authenticated and loopback-only.
- Upstream OAuth credentials are stored locally as plaintext files with owner-only
  permissions.

Default gateway limits include four concurrent executions, 100 tool calls per
execution, ten active calls per execution, and a 256 MiB guest memory limit.

See [limits and boundaries](packages/codemode/README.md#limits-and-boundaries) and
[local deployment](docs/local-installation.md) for the complete contracts.

## Packages

| Package                                                         | Purpose                                                                 |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`@codemode-mcp-gateway/codemode`](packages/codemode/README.md) | Execute JavaScript with host tools, without an MCP dependency           |
| [`@codemode-mcp-gateway/mcp`](packages/mcp/README.md)           | Adapt MCP clients and expose executors as MCP servers                   |
| [`codemode-mcp-gateway`](packages/gateway/README.md)            | Upstream connections, discovery, configuration, OAuth, and the `gw` CLI |

All three currently support Bun only. Package names are provisional and unpublished.

## Development

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run example
```

`bun run check` runs builds, typechecking, lint, formatting checks, tests, and
packaged-consumer verification.

See [testing conventions](docs/testing.md), the [script guide](scripts/README.md),
and [project conventions](AGENTS.md).

## Documentation

- [Documentation index](docs/README.md)
- [Local installation and client setup](docs/local-installation.md)
- [Gateway configuration and CLI](packages/gateway/README.md)
- [Runnable examples](examples/README.md)
- [Execution and MCP reference](docs/reference.md)

## License

[MIT](LICENSE). Third-party components retain their respective licenses and notices.
