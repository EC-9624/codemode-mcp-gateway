# Gateway examples

Requires the full workspace and Bun 1.4.3. Install dependencies from its root with
`bun install --frozen-lockfile --ignore-scripts`. Source examples need no build.
Commands below run from the **workspace root**; package-local commands run relative
to that package (for example, pass `examples/notion.json` there).

## Local stdio demo

```sh
bun run --cwd packages/gateway example
# Equivalent root shortcut:
bun run example:server
```

[stdio-client.ts](stdio-client.ts) owns a source CLI process, selects explicit
stdio, and loads [local.json](local.json). It waits for `math` to connect, prints
the single `execute` tool, discovers/describes `math.add`, and prints `5`.
Closing the client requests EOF shutdown. No setup, token, login, or model is needed.

## Authenticated HTTP demo

In terminal 1:

```sh
bun run gw setup --transport http
bun run gw config check --config packages/gateway/examples/local.json
bun run gw serve --transport http --config packages/gateway/examples/local.json
```

In terminal 2:

```sh
bun run gw status --config packages/gateway/examples/local.json
GW_HTTP_TOKEN="$(bun run gw token show)" bun run example:http
```

[http-client.ts](http-client.ts) connects to the already-running gateway, performs
the same discovery/schema/call sequence, and prints `5`. It deletes its own MCP
session on completion without stopping the gateway. Stop terminal 1 with Ctrl-C.
For another service port, pass its loopback URL as the example's argument.

Setup creates only missing gateway files in your configured HOME/XDG locations.
For an isolated demo, export a temporary `XDG_CONFIG_HOME` and `XDG_STATE_HOME` in
both terminals before setup; remove only those owned temporary directories afterward.
If you manage `GW_HTTP_TOKEN` yourself, use the same environment in both terminals.
The token is sensitive: never echo, log, or commit it. Trust the process owning the
loopback port; this example does not authenticate that process's identity.

## Optional Notion workflow

This accesses your real Notion account and requires consent. It is not part of
the local demo or routine verification.

```sh
bun run gw config check --config packages/gateway/examples/notion.json
bun run gw auth login notion --config packages/gateway/examples/notion.json
bun run example:notion packages/gateway/examples/notion.json "specific search phrase" \
  --page "<page-url-or-id>" --expect "<known text>" --runs 3
```

[notion-client.ts](notion-client.ts) validates discovery, input schemas, search,
and optional fetch identity/content; it prints counts/outcomes, not page bodies.
`--runs` accepts 1–20; `--agents` accepts 1–8 overlapping scripted workflows, not LLM
agents. Failures stop further iterations. Use `--gateway /absolute/path/to/gw` to
exercise an installed executable. Copy `readiness.ts` and `output.ts` beside the
runner when using it outside this checkout. Never commit queries, page IDs, or markers.

[multi.json](multi.json) combines math and Notion; it uses 30/45-second execution
deadlines and eight execution slots for optional workflows, not gateway defaults.
Its local command requires the shared upstream at its checkout-relative path.
Configuration edits require restarting; credential recovery does not replay scripts.
