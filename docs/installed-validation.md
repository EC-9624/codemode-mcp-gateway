# Installed-package validation

Use Bun 1.4.3. All three packages are unpublished; local tarballs and dependency
overrides stand in for registry versions. These checks do not publish packages or
prove registry availability. For the standalone application, see
[local deployment](local-installation.md).

## Automated synthetic checks

From the workspace root after installing dependencies:

```sh
bun run verify:packages
bun run verify:standalone
bun run verify:packages:clean
```

The package check builds explicitly, packs with scripts off, inspects emitted assets
and documentation, and verifies public declarations, worker execution, adapters,
CLI, and user-configured authenticated HTTP in unrelated consumers. The standalone
check runs outside the checkout with an empty PATH and isolated HOME/XDG settings.

The clean-source check copies current nonignored source without existing installs
or builds, performs a frozen install with scripts off, and runs `install:gw` in
an isolated HOME. It checks tarball consumers, deletes its disposable source and
dependencies, and runs the installed binary. No real clients, credentials, or
services are changed. Run build-heavy checks serially within a checkout.

## Prepare an external consumer

For an optional real-account Notion check, run from the workspace root. This
copies only example code/configuration, not credentials. Helpers must accompany
the client because it imports them by relative path.

```sh
bun run build
installed=$(mktemp -d "${TMPDIR:-/tmp}/gw-installed.XXXXXX")
for package in codemode mcp gateway; do
  (cd "packages/$package" && bun pm pack --ignore-scripts --filename "$installed/$package.tgz")
done
mkdir -p "$installed/consumer/config"
cp packages/gateway/examples/notion.json "$installed/consumer/config/notion.json"
cp packages/gateway/examples/notion-client.ts \
  packages/gateway/examples/readiness.ts packages/gateway/examples/output.ts \
  scripts/observe-gateway.ts "$installed/consumer/"
cat > "$installed/consumer/package.json" <<EOF
{
  "name": "gateway-installed-consumer",
  "private": true,
  "type": "module",
  "dependencies": {
    "codemode-mcp-gateway": "file:$installed/gateway.tgz",
    "@modelcontextprotocol/client": "2.3.1",
    "@modelcontextprotocol/server": "2.3.1",
    "zod": "4.3.6"
  },
  "overrides": {
    "@codemode-mcp-gateway/codemode": "file:$installed/codemode.tgz",
    "@codemode-mcp-gateway/mcp": "file:$installed/mcp.tgz"
  }
}
EOF
cd "$installed/consumer"
unset NODE_OPTIONS BUN_OPTIONS
bun install --ignore-scripts
```

Always pass `--gateway` to copied runners; their source-CLI fallback is meaningful
only inside the full repository. It selects an executable path relative to your
working directory, without using development export conditions. Package builds
still require the full workspace; copying a package directory alone is unsupported.

## Optional read-only Notion check

Authorize the configured upstream explicitly before this check. Use the same OS
user, server name, and canonical upstream URL as your saved login; credentials
remain in private plaintext files under
`$XDG_STATE_HOME/codemode-mcp-gateway/credentials` (default
`~/.local/state/codemode-mcp-gateway/credentials`). Do not copy them into the consumer.
Stop on missing authorization rather than launching login implicitly during
validation. Keep real queries, page IDs, and markers out of Git.

```sh
bun notion-client.ts config/notion.json "<specific private query>" \
  --page "<known-page-url-or-id>" --expect "<known text marker>" \
  --gateway ./node_modules/.bin/gw
```

Output contains counts/outcomes, not document bodies. It checks discovery, schemas,
search/fetch identity, optional content, and natural EOF shutdown. The observer can
record MCP outcomes, timing, correlation, and request overlap; it cannot observe
host-only execution categories or internal tool-call counts.

When finished, return to your checkout and remove only your owned temporary
consumer/tarballs directory. Historical installed/client observations, including
OpenCode-version-specific setup, are retained in the
[archive](archive/installed-validation.md). They are not a current compatibility promise.
