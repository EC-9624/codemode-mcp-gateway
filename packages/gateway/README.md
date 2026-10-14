# codemode-mcp-gateway

A Bun stdio gateway that lets coding agents discover and compose one upstream
MCP server's tools through JavaScript. This product package provides both a
programmatic API and the `cmg` executable, composing `@cmg/codemode` and `@cmg/mcp`.
The package remains private while its API matures.

## Run from the repository

```sh
bun install --frozen-lockfile --ignore-scripts
bun run cmg examples/cmg.json
bun run example:server
```

Requires Bun **1.4.2**. `cmg` speaks MCP on stdin/stdout, so it waits for a client;
it is not a JavaScript REPL. `example:server` starts a client and the gateway,
discovers the synthetic upstream's tools, and executes a call end to end.
Stdout is exclusively MCP traffic; diagnostics and upstream stderr use stderr.

## Agent workflow

The agent sees only `execute({ code })`. Submit this async function body to search:

```js
return await tools.searchTools({ query: "add numbers" });
```

Search returns exact names, descriptions, and input schemas. Inspect one with
`tools.describeTool({ name: "add" })`, then call it and return the value you need:

```js
const response = await tools.add({ a: 2, b: 3 });
if (response.isError) return response.content;
return response.structuredContent.sum;
```

For the included upstream, the response contains:

```json
{
  "result": { "ok": true, "value": 5 },
  "calls": [{ "callId": 1, "name": "add", "status": "completed" }]
}
```

Tool names are preserved exactly; use `tools["billing.listInvoices"]` for names
that are not JavaScript identifiers. Local discovery calls share the execution budget.

## Results and failures

The response is emitted as structured content and JSON text. It includes compact
call summaries, not retained tool bodies. Upstream `isError` is data the script
must inspect; outer MCP `isError` indicates that the final execution failed.

Script errors, deadlines, cancellation, and execution limits appear in `result`.
Infrastructure failures use a controlled `sandbox` error; private diagnostics stay
host-side. Cancellation cannot roll back upstream side effects, and a completed
summary does not establish safe retry. See [execution contracts](../../docs/reference.md#execution-reports-and-retained-calls).

## Configuration

Stdio upstream:

```json
{ "upstream": { "transport": "stdio", "command": "bun", "args": ["upstream.ts"] } }
```

`cwd` defaults to the configuration file's directory; a supplied relative `cwd`
resolves from there. `args` pass unchanged. Optional `env` augments SDK defaults.
Command-only configurations without `transport` still select stdio.

HTTP upstream:

```json
{
  "upstream": {
    "transport": "http",
    "url": "https://example.com/mcp",
    "headers": { "Authorization": "Bearer {env:CMG_UPSTREAM_TOKEN}" }
  }
}
```

Header templates expand host environment variables before connecting. Missing
variables fail startup. This static-header mode does not perform OAuth or store credentials.
Optional `sandbox` settings configure the fixed QuickJS policy; app defaults use
a 5-second guest deadline and 10-second total deadline. Other defaults come from codemode.

For example, cap total tool calls without allowing request overrides:

```json
{
  "upstream": { "command": "bun", "args": ["upstream.ts"] },
  "sandbox": { "maxToolCalls": 20 }
}
```

Limits must be positive integers within [codemode's bounds](../codemode/README.md#limits-and-boundaries).
Startup has separate budgets: 5 seconds for the upstream handshake and 15 seconds
for discovery. Configuration and the catalog do not reload during a run.

### Local OAuth

OAuth is opt-in for an explicitly named HTTP connection:

```json
{
  "upstream": {
    "id": "notion",
    "transport": "http",
    "url": "https://mcp.notion.com/mcp",
    "auth": { "type": "oauth" }
  }
}
```

From the repository root:

```sh
bun run cmg login examples/notion.json
bun run example:notion examples/notion.json "your test page" "optional-page-url-or-id"
bun run cmg examples/notion.json
bun run cmg logout examples/notion.json
```

`login` displays an authorization URL and attempts to open the browser. One
five-minute deadline covers credential-lock acquisition, discovery, registration,
browser waiting, and code exchange. Credential-store operations already in progress
cannot be interrupted. PKCE, callback state, and issuer validation
protect the code exchange. Login uses the SDK's metadata, registration, and token
helpers, not a Notion-specific OAuth implementation. Discovery probes the upstream
without credentials for a `WWW-Authenticate` metadata URL, falling back to well-known
discovery when none is advertised. Optional `auth.scope` requests
an explicit space-delimited scope; CMG does not infer a request for every advertised scope.

Serving is noninteractive: it loads the current OS user's saved credentials and
refreshes them without prompting for browser consent. Missing or revoked authorization
requires another explicit login. A permission/scope denial never automatically widens
the grant. Your upstream account and granted authorization determine access.

Credentials and registration details use Bun's experimental `secrets` API (macOS
Keychain or Linux libsecret); there is no plaintext fallback. The OS service may
require unlocking or an access prompt. Connection id and canonical upstream URL
select the entry; stored issuer/resource bindings are checked before refreshing.
Registration's loopback redirect URI is reused, so its port must be available during
later logins. Changing the id or URL selects a new entry; use the original configuration
to log out of the old entry.

Multiple gateway processes can share the same connection and credentials. Ordinary
tool calls hold no credential lock. Before refreshing, CMG acquires a short
`proper-lockfile` lock, reloads credentials, and reuses a token already replaced by
another process. Otherwise it refreshes and saves under that lock. No native FFI is used.

The lock lives in `$XDG_STATE_HOME/cmg/locks` (default `~/.local/state/cmg/locks`)
and contains no credentials. CMG renews it every second; an abandoned lock becomes
eligible for recovery after 20 seconds. Acquisition waits up to 25 seconds and is
cancellable during serving/login. Lost ownership aborts auth requests and blocks
further credential writes. This is an advisory heartbeat lock, not transactional
fencing against an arbitrarily suspended process. The OS credential service must
still be available on the host. Restart all older gateways when upgrading from the
previous native lifetime-lock implementation; the two lock protocols must not mix.

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
Remote rotation and local persistence are not transactional: interrupted/lost
responses can require reauthorization. Auth network requests have a 15-second
timeout, use HTTPS except for loopback development, and reject HTTP redirects.
Tool payloads and aggregate memory remain subject to the existing documented limitations.

`logout` removes local credentials and registration details; it does **not** revoke
the upstream grant. Revoke access in the provider's settings when necessary.
The Notion smoke example performs read-only discovery/search and optional fetch,
printing summaries rather than page bodies. Its tool names target Notion's current
user-authorized server, not older workspace-owned catalogs.

Automated OAuth tests use synthetic servers and isolated stores. Live Notion and
real OS credential-service validation require explicit interactive authorization
and are not part of the default suite.

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
`session.ts` owns noninteractive refresh coordination, and `credentials.ts`
owns token normalization and OS-backed persistence. All are internal modules.

## Programmatic API

```ts
import { ToolCatalog, ToolResult } from "@cmg/codemode";
import { createServer } from "codemode-mcp-gateway";

const catalog = ToolCatalog.create({
  answer: { description: "Return the answer", execute: () => ToolResult.success(42) },
});
const server = createServer(catalog, { timeoutMs: 5_000 });
// Connect an application-owned transport and serve requests here, then close the server.
await server.close();
```

`createServer` composes a catalog and fixed sandbox policy without loading files
or installing process listeners. The caller owns the transport and any external
connections used by its catalog.

The public entry also exports `Configuration`, `resolveHeaders`, and
`serve(configurationPath)`. Unlike `createServer`, `serve` owns the complete stdio
process lifetime, including configuration loading and shutdown listeners. Importing
the package alone starts neither path. See the [public exports](src/index.ts).

`login(path, options?)` and `logout(path, options?)` return explicit `AuthResult`
values for expected authorization/storage failures. Configuration, infrastructure,
and cleanup failures may reject, including `AuthorizationError` when releasing a
credential lock fails. `serve(path, options?)` accepts the same
host-owned scoped credential-store factory and lock-directory override; the CLI
uses the OS store. A custom store must preserve credential bindings and durable,
atomic snapshot replacement, including for readers outside the lock. The exported
`Credentials` schema validates stored snapshots; custom stores must also validate
the connection binding. All processes
sharing credentials must use the same lock directory. Imports perform no credential reads, browser launches, or
process-listener registration.

`serve` rejects with exported `AuthorizationError` for recognized authorization
failures. Its `failure` carries a controlled kind/message and optional private cause;
do not serialize causes into MCP responses or diagnostic logs.

## How it works

```text
configuration -> connect upstream -> snapshot tools and compile schemas
  -> add local discovery -> fixed-policy QuickJS executor -> MCP execute server

agent code -> worker/guest -> host tool adapter -> upstream MCP
           <- processed result and compact call summaries
```

Composition rejects upstream names `searchTools` and `describeTool` rather than
overwriting them. The MCP adapter borrows an executor; this package selects QuickJS
and describes its actual environment to the agent.

EOF, SIGINT, and SIGTERM cancel active executions and await worker cleanup before
closing the upstream. Stdio shutdown observes the child's actual close event;
HTTP shutdown requests session deletion when supported, with a 5-second DELETE
request timeout. The agent-facing transport opens during upstream setup, so EOF
can also cancel a stalled handshake or discovery.

[`cli.ts`](src/cli.ts) is the executable entry; [`main.ts`](src/main.ts) handles
arguments and exit status. [`composition.ts`](src/composition.ts) selects policy;
[`server.ts`](src/server.ts) explains startup and cleanup ordering beside the code.

`bun run build` emits `dist/cli.js` with a Bun shebang. After installing a packed
build, invoke it as `cmg configuration.json`; dependencies are not bundled.

## Current scope

One upstream, a startup catalog snapshot, and agent-facing stdio only. HTTP refers
to the upstream connection, not remote agent hosting. There is no model loop,
multi-upstream routing, persistence, or Node support. Cancellation cannot roll back
upstream side effects. Real-upstream validation, performance measurement, and
aggregate/payload resource hardening remain future work. Local OAuth serves one
OS user; team-member identity, hosted authentication, and shared credential management
are not implemented.

## Development

From the workspace root:

```sh
bun run --cwd packages/gateway test
bun run --cwd packages/gateway check
```

This package owns configuration, composition, CLI, end-to-end gateway, and
stdio/HTTP shutdown tests in a flat `tests/` directory, grouped by public subject.
`login.test.ts`, `login-callback.test.ts`, and `logout.test.ts` specify authorization
workflows through public login/logout; `credentials.test.ts` specifies the exported schema.
`authorization.test.ts` exercises running gateways through real SDK clients.
Only `credential-ownership.test.ts` retains internal session/lease probes, for
out-of-order store completions, persistence publication, and compromised/crashed
lock ownership that the public serving API cannot expose precisely. The real OS adapter
is exercised through public login/logout with scoped spies on Bun's secret service.
Its helpers and upstream fixtures are package-local. Packed-consumer fixtures additionally verify the installed API
and `cmg` executable through the root distribution checks.
See [testing conventions](../../docs/testing.md).
