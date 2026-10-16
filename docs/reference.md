# Execution and MCP reference

Detailed edge cases and execution contracts. For usage, start with the
[codemode](../packages/codemode/README.md), [MCP](../packages/mcp/README.md), or
[gateway](../packages/gateway/README.md) guide. Run commands from the workspace root.

- [Usage](#usage)
- [Resource limits](#resource-limits), [output limits](#final-output-limit), and [tool-call limits](#tool-call-limits)
- [Execution reports](#execution-reports-and-call-summaries) and [cancellation](#cancellation)
- [Catalog and discovery](#catalog-and-discovery)
- [Validated tools](#validated-tool-contracts) and [MCP adapter](#mcp-upstream-adapter)
- [Agent-facing MCP server](#agent-facing-mcp-server)
- [Architecture](#architecture), [ownership](#ownership), and [contracts](#contracts)
- [Limitations](#limitations) and [checks](#code-style-and-checks)

## Usage

Import package roots; runtime deep imports are unsupported. Exact signatures and
field contracts live in the public exports of [codemode](../packages/codemode/src/index.ts),
[MCP](../packages/mcp/src/index.ts), and [gateway](../packages/gateway/src/index.ts).

`new CodeExecutor({ tools, ...configuration })` validates limits and snapshots default tool
bindings synchronously, before any worker starts. Constructor registry failures
throw `SandboxExecutionError` with no calls; invalid configuration throws `RangeError`.
Defaults and limits stay fixed for that instance. `sandbox.execute(code, { tools, signal }?)`
accepts host-supplied tool bindings and cancellation, never resource-limit overrides.
Supplied tools replace defaults for that run without mutating them; `{}` exposes no
tools, while omission/`undefined` uses the defaults. Each admitted execution copies
supplied bindings synchronously into a private map before worker creation, using the
same map for guest tool names and host dispatch. Registry read failures reject with
host-only `SandboxExecutionError` diagnostics and release admission without a worker.
Each admitted run owns its resources and can overlap other runs up to the instance's
`maxConcurrentExecutions` (default 4); caller signals belong to individual runs.
The sandbox holds configuration rather than live workers between runs, so it needs
no `close()` call. Every execution awaits its own worker cleanup.

An agent-facing MCP handler accepts `{ code }` and supplies request cancellation
separately; tool selection remains host-owned. Migration from `execute(code, tools, options)`:
move limits into the constructor and supply tools as constructor defaults or per-run
options. See [the runnable example](../examples/basic.ts).

Input is the body of an async function, not an expression or a module. Each call
runs in a fresh worker with a fresh QuickJS runtime and context. Only explicitly
supplied tools are exposed, on a frozen, null-prototype `tools` object that is
both the function parameter and `globalThis.tools`. `process`, `Bun`, `require`,
and `fetch` are not exposed.

Tool callbacks receive `unknown` arguments and a host-only `ToolContext` containing
an execution-scoped `signal`. Existing callbacks can ignore the second argument.
Callbacks must validate their domain inputs.
They return `ToolResult.success(value)` or `ToolResult.failure(publicMessage)`
rather than throwing validation errors. Guests receive ordinary values or
catchable promise rejections. Failure-shaped data wrapped in `success` remains
ordinary data.

Both library deadlines are unset by default. Configured deadlines start fresh for
each execution using the stored durations. Either guest
or parent deadline can win; neither must be larger than the other. See
[completion and deadline](#completion-and-deadline) and
[parent supervision](#parent-supervised-deadline) for their exact coverage.

### Resource limits

All limits are optional, flat fields on `SandboxOptions`. Configure them once:

```ts
const sandbox = new CodeExecutor({ tools, memoryLimitBytes: 128 * 1024 * 1024 });
await sandbox.execute(code);
```

Defaults are listed in the [codemode configuration table](../packages/codemode/README.md#limits-and-boundaries).
Omitted (`undefined`) constructor fields use the built-in default; `null` is invalid.
Each value must be a positive integer.
Memory, source, and output limits allow up to 2147483647 bytes; the stack limit allows up to
4 MiB (`4194304`), leaving headroom below the pinned WASM build's 5 MiB stack.
Invalid values throw `RangeError` during construction before registry access or worker
startup. Zero, negative values, and infinity do not disable limits.

At execution time, pre-aborted cancellation wins. Otherwise oversized source
returns this report before creating the worker or parsing code:

```ts
await new CodeExecutor({ maxSourceBytes: 5 }).execute("return 42;");
// {
//   result: {
//     ok: false,
//     error: {
//       kind: "limit", resource: "source", maximum: 5,
//       message: "Source exceeds the 5 byte limit."
//     }
//   },
//   calls: []
// }
```

The source limit counts the supplied body, including comments and whitespace,
but excludes the private wrapper/prelude. UTF-8 bytes differ from JavaScript
string length for non-ASCII text. Byte measurement does not allocate an encoded
copy of the source.

```text
construction: apply defaults -> validate configuration -> snapshot default tools
execution: check pre-aborted cancellation -> measure source bytes
  -> reject oversized source with no calls
  -> reserve execution capacity, or reject with limit/executions and no calls
  -> snapshot supplied tools, or use constructor defaults
  -> start worker with stored limits
  -> worker validates startup data -> configure VM -> execute
```

VM memory and stack limits apply to each fresh execution. Guest allocation and
recursion errors retain ordinary JavaScript behavior: scripts can catch them;
uncaught errors become `script` results. Failures in VM/bridge/prelude setup or execution
machinery still reject with `SandboxExecutionError`. Error text is not used to
guess a structured memory/stack limit failure. Very small limits can prevent
sandbox setup from completing.

These settings do not cap total host/WASM memory or enlarge the WASM build's
physical stack. Source admission happens before the execution deadlines start;
guest parsing is covered by either deadline when configured.

### Execution capacity

`maxConcurrentExecutions` is a fixed positive integer from 1 to 2147483647, default
4, counted independently by each executor. It is parent-owned policy and is not sent
to or enforced by the guest. Reusing an executor shares capacity across requests;
constructing another executor creates a separate budget. Per-execution tool snapshots
use the same instance budget, released only after cleanup/actual exit.

Admission happens synchronously after pre-aborted cancellation and source-size
checks, before worker creation. An excess submission resolves to
`{ result: { ok: false, error: { kind: "limit", resource: "executions", maximum,
message: "Executor reached the N concurrent-execution limit." } }, calls: [] }`,
with `N` replaced by the configured maximum. No queue, tool dispatch, or retry occurs.
Only the rejected submission fails; already admitted executions continue.

The reservation is released after worker cleanup settles, including guest failures,
timeouts, cancellation, and infrastructure errors. A startup-construction failure
also releases it. If termination rejects before actual worker exit, the execution
still rejects, but its capacity is held until exit is observed. Cleanup settling
after native exit still holds capacity until that cleanup promise settles.

Capacity counts executions through worker cleanup, not uncooperative host callbacks
that continue after cancellation. It does not impose a process-wide memory bound,
span separate gateway instances, or replace the per-execution tool-call limits.

### Final output limit

`maxOutputBytes` bounds the guest's final return value and script-error message:

```ts
await new CodeExecutor({ maxOutputBytes: 5 }).execute('return "too much";');
// {
//   result: {
//     ok: false,
//     error: {
//       kind: "limit", resource: "output", maximum: 5,
//       message: "Output exceeds the 5 byte limit."
//     }
//   },
//   calls: []
// }
```

Return values count their serialized JSON bytes, including quotes and escapes;
undefined returns normalize to `null` (four bytes). Script errors count the raw
message's UTF-8 bytes, including thrown strings, syntax errors, and conversion
errors. Exactly the configured size is accepted. Oversized output is rejected,
not truncated.

```text
guest serializes return value once -> drain started calls and guest jobs
  -> worker measures JSON text -> output limit, or parse and return value
guest throws -> convert public script-error message
  -> worker measures message -> output limit, or return script error
```

Size checks run in the worker before sending the result to the parent. JSON return
text is checked before parsing into host data. Controlled timeout, cancellation,
and limit diagnostics are not subject to this content limit; an output-limit
message can itself be longer than a very small configured maximum.

Completed call summaries remain available. Pending calls when an oversized script
error ends execution are interrupted with `reason: "output-limit"`, including
when worker cleanup later fails. Return values retain the existing drain-before-
completion behavior. Tool arguments and responses
are not capped by `maxOutputBytes`: a script can process a large dataset and return
a small summary. This is a final guest-output bound, not a bound on the full report.

Serialization, error conversion, and reading text from the VM can allocate before
measurement. The output limit does not bound those temporary allocations or total
host memory.

### Tool-call limits

Each execution defaults to **100 total calls** and **10 active calls**, with further
calls queued in invocation order until a slot is free.
Configure either field independently on the sandbox:

```ts
const sandbox = new CodeExecutor({ tools, maxToolCalls: 200, maxConcurrentToolCalls: 5 });
await sandbox.execute(code);
```

Both counts must be integers from 1 to 2147483647. Invalid counts throw
`RangeError` during construction before registry access or worker startup.
A total limit below the concurrency limit is valid; there is no required relationship
between them.

- Each admitted invocation consumes one total call, including queued calls, tool failures,
  discovery, and unawaited calls. Awaiting the same promise twice counts once.
- Argument serialization failures before admission consume no call capacity.
- A concurrency slot remains occupied until the response is handled: through
  guest-promise settlement on the worker, and through serialization/transport on
  the parent. Completed success or failure responses release the slot.
- Excess concurrency queues on the worker instead of failing. The total-call
  budget bounds admitted active and queued calls together. Queueing is not retrying.
- Exceeding the total-call budget ends execution with a structured limit result;
  guest `try/catch` cannot bypass it. Failure, timeout, or cancellation discards
  queued calls without invoking them. Queued wait counts toward configured deadlines.

```ts
const sandbox = new CodeExecutor({
  tools: {
    read: () => ToolResult.success(42),
  },
  maxToolCalls: 1,
});

await sandbox.execute("await tools.read(); return await tools.read();");
// {
//   result: {
//     ok: false,
//     error: {
//       kind: "limit", resource: "tool-calls", maximum: 1,
//       message: "Execution exceeded the 1 tool-call limit."
//     }
//   },
//   calls: [{ callId: 1, name: "read", status: "completed" }]
// }
```

Queued and rejected calls do not appear in the dispatched-call report. The parent
retains an independent hard concurrency guard for invalid worker traffic, using
`resource: "concurrent-tool-calls"`; normal excess guest concurrency queues instead.
Completed responses stay completed; pending dispatched calls become interrupted with
`reason: "call-limit"` (or `"concurrency-limit"` for the parent safeguard). The parent requests cooperative
tool cancellation and awaits worker cleanup. A later cleanup failure retains the
selected interruption reason in `SandboxExecutionError.calls`.

```text
guest serializes arguments and records a guest promise resolver
  -> worker validates payload and reserves total capacity
       denied -> record structured limit, interrupt guest execution
       admitted -> record outstanding ID and queue until an active slot is free
       slot available -> post next tool request in invocation order
  -> parent validates request and independently reserves capacity
       denied -> select limit result and close dispatch/call snapshot
       admitted -> record dispatch, invoke tool, retain and post response
  -> parent releases slot; worker settles guest promise and dispatches next queued call
```

Checking on the worker bounds admitted calls and posted requests during a
synchronous guest burst. Checking on the parent independently bounds host dispatch.
The two budgets are local to their execution boundaries; reply transit can keep a
worker slot occupied after the parent has released its slot. Limits are per
execution, not application-wide. Tools that ignore cancellation may continue after
their execution has ended.

### Execution reports and call summaries

`sandbox.execute` returns `Promise<ExecutionReport>`: `{ result: SandboxResult, calls }`.
Callers migrating from the earlier API read `report.result` for the execution outcome.
The worker-local engine still returns `GuestResult`; only the parent owns call records.

Each call record has an execution-local `callId`, tool `name`, and one of:

- `completed`: the parent serialized a public response before selecting
  the execution outcome. The record contains no response body or failure message.
- `interrupted`: the parent started invocation but had not marked it completed
  when execution stopped. `reason` explains why observation ended:
  `cancelled`, `timeout`, `script-error`, `sandbox-error`, `call-limit`, `concurrency-limit`, or `output-limit`.
  The operation may still finish or have side effects.

`cancelled` means the caller requested cancellation; `timeout` means a guest or
total deadline expired; `script-error` means guest execution failed; `sandbox-error`
means the worker, transport, or execution machinery failed. Detailed sandbox
failure causes remain on `SandboxExecutionError` rather than in each call record.
`call-limit` and `concurrency-limit` identify execution stopped by tool admission.
`output-limit` identifies an oversized final guest result or script-error message.

Completed means an observed response, not guest receipt or proof of an external
transaction. Even a failed response, including the generic response for a thrown
callback, does not establish that no side effects occurred. Cancellation or
deadline expiry during result conversion leaves the call interrupted for that reason.

Records remain in invocation order, even when replies arrive out of order. Calls
rejected before invocation, including malformed requests, do not appear. Call
arguments, raw host objects, serialized response bodies, and tool failure messages
are never stored in the call log or report. Serialization still runs once to prepare
complete values for the guest, preserving undefined distinctly from null. Transient
tool results and transport buffers remain necessary while delivery is in progress.

**API change:** the former completed-call `result` field is removed. There is one
summary-only policy for library reports, infrastructure-error call snapshots, and
gateway responses, with no configuration switch. Scripts can deliberately return
selected tool data through the final `report.result`, subject to the output limit.

Call outcomes are exposed through `readonly` TypeScript types. The sandbox stops
updating the snapshot when the parent selects the execution outcome, before
notifying tool abort listeners or awaiting worker termination. Late settlements cannot change it and
are discarded before conversion. These records are in-memory observations, not a
durable audit log or a guarantee of safe retry.

For example, cancellation after invoice creation but during a second tool call:

```ts
const report = {
  result: {
    ok: false,
    error: { kind: "cancelled", message: "Execution cancelled." },
  },
  calls: [
    {
      callId: 1,
      name: "createInvoice",
      status: "completed",
    },
    { callId: 2, name: "wait", status: "interrupted", reason: "cancelled" },
  ],
};
```

`bun run example` demonstrates this sequence using an explicit start gate.

`SandboxExecutionError` carries the same snapshot in `calls`; its `cause`
preserves the original host-side failure. If execution and cleanup both
throw, the cause retains the disposal `SuppressedError` chain. See
[results and failures](#results-and-failures) for error classification.

Once selected, interruption reasons do not change during cleanup. For example,
cancellation followed by a termination failure rejects with `SandboxExecutionError`,
but pending calls keep `reason: "cancelled"`. Completed calls remain completed.

```ts
import { CodeExecutor, SandboxExecutionError } from "@codemode-mcp-gateway/codemode";

try {
  const sandbox = new CodeExecutor();
  const report = await sandbox.execute("return 42;");
  console.log(report.result, report.calls);
} catch (error) {
  if (error instanceof SandboxExecutionError) {
    console.error(error.calls, error.cause); // Host-only diagnostics.
  }

  throw error;
}
```

### Cancellation

Pass a caller signal to cancel execution. Tools can pass their separate execution
signal to cancellable APIs such as `fetch`:

```ts
const controller = new AbortController();
const sandbox = new CodeExecutor({
  tools: {
    read: async (_args, { signal }) => {
      const response = await fetch("https://example.com/data", { signal });

      return ToolResult.success(await response.text());
    },
  },
});

const completion = sandbox.execute("return await tools.read();", { signal: controller.signal });

controller.abort();
await completion;
// { result: { ok: false, error: { kind: "cancelled", message: "Execution cancelled." } }, calls: [] }
```

All calls in one execution share a tool signal. Cancellation, timeout, script
failure, and worker infrastructure failure request tool cancellation. Successful
guest completion leaves that signal un-aborted. Tools that subscribe manually
should remove their listeners when their work finishes.

Cancellation is cooperative: a tool can ignore the signal and may still complete
or have side effects. Execution waits for worker termination, not for cancelled
tools to settle. A cancelled result does not establish whether dispatched tools
completed, and does not mean retrying them is safe.

### Catalog and discovery

The app owns tool metadata and implementations. `ToolCatalog.create` snapshots
callback bindings, names, and descriptions from a definition record. `defineTool`
builds validated native definitions; `createMcpCatalog` builds validated MCP
definitions. On manually supplied definitions, `inputSchema` is descriptive JSON
metadata and the callback owns validation. Discovery schema objects should be
treated as read-only.

```ts
import {
  createDiscoveryTools,
  CodeExecutor,
  ToolCatalog,
  ToolResult,
} from "@codemode-mcp-gateway/codemode";

const catalog = ToolCatalog.create({
  answer: {
    description: "Return the answer to the example question",
    execute: () => ToolResult.success(42),
  },
});

catalog.search("answer"); // [{ name: "answer", description: "..." }]
catalog.describe("answer"); // metadata; undefined for an unknown name

const discovery = createDiscoveryTools(catalog);
const sandbox = new CodeExecutor({
  tools: {
    ...catalog.tools,
    searchTools: discovery.searchTools,
    describeTool: discovery.describeTool,
  },
});

await sandbox.execute(
  `
  const matches = await tools.searchTools({ query: "answer" });
  const name = matches.tools[0].name;
  const description = await tools.describeTool({ name });
  return { description, value: await tools[name]() };
`,
);
```

- Search matches whitespace-separated query terms case-insensitively. Rank first
  by distinct terms in the name, then by distinct terms in the combined name and
  description; ties retain catalog order. Matching uses complete descriptions.
  Blank or unmatched host queries return an empty list.
- Host `catalog.search()` returns all matching full metadata, including input schemas.
  `catalog.describe()` and guest `describeTool` return complete metadata for one name.
  Neither exposes implementations or extra definition fields, or invokes a tool.
- Guest `searchTools({ query, limit?, offset? })` returns
  `{ tools: [{ name, description }], total, nextOffset }`. It defaults to five results
  at offset zero. Description previews collapse whitespace and use at most 200
  UTF-16 code units, ending in `…` when shortened. Search pages omit input schemas.
  Select the needed tools, then call `describeTool` for their full input contracts.
- `limit` must be a positive safe integer; `offset` must be a non-negative safe
  integer. Repeat the same query with `offset: nextOffset` to browse further;
  `nextOffset: null` marks completion. Beyond the last match, `tools` is empty and
  `total` still reports the match count. Pagination is a discovery preference, not
  a new constructor-owned resource limit.
- Migration: `searchTools` previously returned an array of full metadata. Read
  `page.tools` instead, use `describeTool` for schemas, and follow `nextOffset` when
  more matches are needed. The host `ToolCatalog.search` return shape is unchanged.
- Discovery callbacks are ordinary tools. Invalid requests and missing names
  produce deliberately public tool failures.
- The app chooses discovery names, so it can expose `findTools: discovery.searchTools`
  when its catalog already contains a tool named `searchTools`.
- Names are preserved exactly: use `tools["billing.listInvoices"]` for names that
  are not JavaScript identifiers.

Only callable names go to the worker at startup; metadata reaches the guest when
discovery returns it. The MCP adapter supplies definitions and callbacks through
this same boundary.

### Validated tool contracts

`defineTool` accepts Standard Schema validators with Standard JSON Schema export,
including compatible Zod, Valibot, or custom schemas. The handler receives the
schema's inferred **output** type, including intentional transformations:

```ts
import { z } from "zod";
import { defineTool, CodeExecutor, ToolCatalog, ToolResult } from "@codemode-mcp-gateway/codemode";

const catalog = ToolCatalog.create({
  length: defineTool({
    description: "Count characters in a non-empty string",
    inputSchema: z
      .string()
      .min(1)
      .transform((text) => text.length),
    execute: (length) => ToolResult.success(length + 1), // length is inferred as number
  }),
});

const sandbox = new CodeExecutor({ tools: catalog.tools });
await sandbox.execute('return await tools.length("hello");');
// result: { ok: true, value: 6 }
```

```text
definition: export input JSON Schema once -> snapshot metadata -> wrap typed handler
invocation: check cancellation -> await Standard Schema validation
  -> check cancellation -> public validation failure, or execute(result.value)
```

The public `ToolInputSchema<Input, Output>` is
`StandardSchemaV1<Input, Output> & StandardJSONSchemaV1<Input, Output>`.
Validation uses `~standard.validate`; discovery uses
`~standard.jsonSchema.input({ target: "draft-2020-12" })`. Standard Schema alone
does not guarantee JSON export. Export failures reject definition setup on the
host. Native refinements may enforce rules richer than the exported description.
CMG never compiles native schema objects with Ajv or clones their executable methods.
Treat the supplied schema as immutable after definition.

Both synchronous and asynchronous validators are supported. The schema determines
coercion, defaults, refinements, and transformations; the implementation receives
the validated output. Native omitted arguments arrive at the schema as `undefined`.
One reported issue becomes a catchable failure such as
`Invalid arguments: /id: Expected a number.`. Standard issue paths are rendered
as JSON Pointers, including escaped object keys. CMG does not append the arguments;
custom validators own the content of their public issue messages.

Locally rejected calls consume the existing call budget and are recorded as
`status: "completed"` without the failure body. The guest can catch the rejection
and correct its arguments. Thrown exceptions and rejected validation promises use
the existing private host-tool failure boundary. Standard Schema supplies no
cancellation signal: cancellation can end observation while validation is pending,
but an aborted signal prevents subsequent handler invocation when validation settles.
Synchronous validator work runs on the host thread and cannot be preempted.

Dependency note: Zod 4.3.6's Standard adapter first attempts synchronous parsing.
A throwing async transform can leave a rejected promise from that probe outside
the returned validation promise. CMG can handle returned promises, not promises a
validator discards; use reported validation issues for expected failures and keep
schema validation free of side effects.

### MCP upstream adapter

`createMcpCatalog(client, options?)` discovers a snapshot from an already-connected
official MCP SDK v2 client. The application owns connection settings, credentials,
protocol negotiation, and closing the client. The adapter borrows it on both
success and failure; cancelling one execution does not close the shared client.

```ts
import { CodeExecutor } from "@codemode-mcp-gateway/codemode";
import { createMcpCatalog } from "@codemode-mcp-gateway/mcp";

// client is an application-owned, connected @modelcontextprotocol/client Client.
const catalog = await createMcpCatalog(client);
const sandbox = new CodeExecutor({ tools: catalog.tools });
const report = await sandbox.execute(
  `
    const response = await tools.add({ a: 2, b: 3 });
    if (response.isError) return response.content;
    return response.structuredContent.sum;
  `,
);
```

Run `bun run example:mcp` for the complete stdio workflow. It starts
`examples/mcp-server.ts` as a Bun child process, calls the synthetic `add`, `fail`,
and `dataset` tools, then closes the client. `examples/mcp-tools.ts` also exposes
`wait`, whose handler cooperates with request cancellation. Server diagnostics
belong on stderr; stdout is reserved for protocol messages.

#### Discovery

```ts
await createMcpCatalog(client, {
  timeoutMs: 15_000, // default; overall discovery budget across pages
  signal, // optional; cancels discovery only
});
```

`timeoutMs` must be an integer from 1 through 2147483647. Invalid options reject
before cancellation or network work. An already-aborted signal rejects before
discovery. Setup failures stay on the host, outside `ExecutionReport`; SDK
rejections retain their original identity. Discovery releases its timer and caller
abort listener on every exit.

Discovery uses the SDK's `listTools` aggregation with `cacheMode: "refresh"`.
Rebuilding requests a fresh listing without changing an earlier catalog's names
or callbacks. SDK v2.3.1 defaults to a 64-page cap and throws when it is exceeded;
it treats identical consecutive pages with the same cursor as the end of a list.
The adapter rejects duplicate names, preserves original names and input schemas,
and supplies `MCP tool: <name>` when a description is absent. A connected server
without the tools capability produces an empty catalog without a listing request.

Use the existing `createDiscoveryTools(catalog)` to expose search/description to
guest code, choosing callback names that do not collide with upstream tools.

#### Invocation and responses

```text
guest calls tools[name](args)
  -> existing worker/host bridge and call budgets
  -> adapter validates object shape (omitted arguments become {})
  -> Standard Schema wrapper validates using the compiled JSON Schema adapter
  -> client.callTool with the execution's AbortSignal
  -> project content, optional structuredContent, optional isError
  -> ToolResult.success(response)
  -> existing single serialization, completed call summary, guest settlement
```

Arrays, null, and primitive arguments return the public failure
`MCP tool arguments must be an object.` before sending an MCP request. Omitted
arguments are normalized to `{}` **before** schema validation. Objects that fail
the discovered schema produce a catchable `Invalid arguments for "<tool>": ...`
failure without an upstream request. This extends the existing local shape-error
contract: schema-invalid calls that previously reached the server now reject
locally, rather than resolving as an upstream `isError` envelope.
Servers still validate their own inputs and may enforce stricter rules than they
advertise. Invalid discovered input schemas reject catalog construction without
closing the borrowed client.

Raw MCP input schemas are copied and compiled once with Ajv 8.18.0. The adapter
supports default/explicit JSON Schema 2020-12, explicit draft-07, boolean schemas,
and local definitions, anchors, and recursive references. HTTP/HTTPS dialect URI
aliases and trailing `#` are accepted. Unsupported dialects, invalid schemas,
unresolved external references, and Ajv `$async` validators fail setup; dependency
causes stay available on the host. No external schemas are fetched.

The JSON adapter performs no coercion, default insertion, property removal, or
argument replacement. Only own properties satisfy object requirements. Formats
from `ajv-formats` are checked; unknown format/extension annotations are permitted.
Independent engines isolate root and nested `$id` values across tools. One shared
engine per dialect checks schemas against the meta-schema without registering them,
so its validator is compiled once rather than per tool. These
JSON-specific rules do not restrict native Standard Schema validators.

The SDK can validate output schemas learned during discovery using its own
metadata cache; the adapter does not add another validator.

Guest response handling preserves MCP data:

- `content` blocks are preserved without parsing text or fetching resource links.
- `structuredContent` is retained when present, including arrays, null, false,
  zero, and empty strings. The negotiated MCP revision determines its wire shape.
- `isError: true` **resolves as data**, including server-side input-validation
  errors. Guest code checks it explicitly.
- Top-level `_meta` and unrelated extension fields are excluded. Metadata inside
  content blocks is preserved.
- Invocation `ProtocolError`s reject with the tool name, numeric code, and message.
  This intentionally includes SDK-generated output-schema errors: the class does
  not establish whether an error came from upstream. Error data and stacks are
  excluded; messages are public, not redacted, and must not contain secrets.
  Other invocation exceptions remain generic `Host tool failed.` rejections.
  Hosts observe the original cause in both cases through `onToolException`; `gw`
  writes the original error name/message/code to stderr.

A completed call can therefore have delivered an upstream response with
`isError: true`: the summary records completion, while the MCP flag received by
the script describes the tool's outcome. A lost connection only establishes
that a usable response was not obtained; it does not establish external failure.

#### Cancellation, ownership, and current scope

Connection setup, discovery, and execution have separate lifetimes. Execution
deadlines do not cover the preceding connect/list phase. Discovery's signal is
not captured by invocation callbacks. Each invocation instead forwards the
execution's `ToolContext.signal`; server handlers must cooperate with cancellation.
Late completions cannot change the closed execution report. The SDK's own request
timeout can also end an individual call before CMG's execution deadline.
Discovery checks its overall deadline again after synchronous schema compilation;
it rejects an over-budget result but cannot interrupt compilation mid-operation.

The example uses the SDK's default legacy handshake. Modern JSON response values
are also tested through an in-process HTTP handler. Protocol negotiation remains
application-owned; automatic stdio negotiation can spawn a separate probe child.
Lifecycle tests observe actual child exit, including after failed setup. In SDK
v2.3.1 a failed legacy handshake initiates close without awaiting it, so a subsequent
`client.close()` can return before that earlier teardown finishes.

The adapter adds no retries. SDK protocol flows may issue multiple wire requests
per invocation; execution call budgets count host-tool invocations, not wire
attempts. Catalog refresh is explicit, and client reuse, authentication, and
interactive request handlers remain application-owned. Tool payloads still have no
CMG-specific cap; SDK transport limits also apply. Reports do not retain tool bodies.

## Agent-facing MCP server

`createCodemodeServer({ execute, description? })` returns an SDK `McpServer` exposing
exactly one tool, `execute`. It borrows an application-supplied execution callback
and does not construct a sandbox or inject discovery. The callback receives code
and `{ signal }`, returns `Promise<ExecutionReport>`, and must settle only after
owned execution cleanup. Synchronous callback exceptions use the same private
infrastructure rejection path as asynchronous failures. An optional description
documents the supplied environment; the default makes no engine-specific claims.

```ts
import { CodeExecutor } from "@codemode-mcp-gateway/codemode";
import { createCodemodeServer, createMcpCatalog } from "@codemode-mcp-gateway/mcp";

const catalog = await createMcpCatalog(client);
const sandbox = new CodeExecutor({
  tools: catalog.tools,
  timeoutMs: 5_000,
  totalTimeoutMs: 10_000,
});
const server = createCodemodeServer({
  execute: (code, options) => sandbox.execute(code, options),
});
// Connect server to an application-owned MCP transport.
// await server.connect(transport);
// await server.close();
```

The application retains ownership of the upstream client. `server.close()` is
idempotent: it aborts this server's active execution signals, closes the agent-facing
connection, and awaits execution promises. It does not globally close a shared
executor. Our sandbox awaits its worker cleanup before settling; alternative
executors must implement the same cleanup contract. The application then closes
its upstream client. Cancellation is cooperative for host tools.

### Requests and discovery

The input schema is a strict `{ code: string }` object. Unknown keys, including
resource-limit overrides, fail MCP input validation before execution. Input is
JavaScript source interpreted by the injected executor. The CMG gateway
selects our async-function-body contract; a final `return` selects its result.

The CMG gateway qualifies upstream names and combines them with local discovery helpers.
An upstream tool named `searchTools` remains callable as `server.searchTools`. These helpers are not supplied by
the generic MCP server. In CMG, discovery runs with the same host-call budget:

```js
return await tools.searchTools({ query: "customer invoices" });
```

This returns a page of exact names and short descriptions, without input schemas.
An unmatched query returns `{ tools: [], total: 0, nextOffset: null, servers }`; invalid
discovery arguments are catchable tool failures. `tools.describeTool({ name })`
returns the complete description and input schema for one upstream tool. The catalog
is a fixed snapshot for each execution; the helper tools themselves are described
in `execute`'s description rather than added to the upstream search index. Gateway
discovery accepts a `server` search filter and returns a `servers`
availability snapshot, including failed/unauthenticated entries with no tools.

### Responses

One text content block contains only the returned value or useful error message.
Strings stay plain; other values use compact JSON. The adapter omits `structuredContent`,
call summaries, and the execution envelope; the full `ExecutionReport` stays host-side.
On success, `isError` is omitted. On failure, `isError: true` is included.
Inspect upstream `isError` inside JavaScript when its outcome matters: catching an
upstream failure and returning normally is still successful execution.

The optional host `formatOutput(text)` callback supplies presentation without
changing the executor report. Server shutdown awaits the callback as well as the
executor; its shutdown guard prevents late SDK-validated requests from starting work.
Unexpected formatting errors produce a controlled output-delivery error and private
diagnostics, never a script replay.
An optional host `onClose()` releases presentation resources after execution and
formatting have drained. Close awaits it and preserves cleanup failures host-side.

The gateway supplies pi-style spilling above 40,000 UTF-8 bytes: it saves complete
rendered output and returns a UTF-8-safe head/tail preview with a full local path.
Files use exclusive creation and owner-only permissions in a private temp directory;
session retirement removes that session's directory only after tracked requests/presentation finish.
The harness reads the file with its native tools on the shared filesystem. No custom
artifact tool, TTL, aggregate storage quota, or crash-leftover sweep is provided.
Save errors keep the preview and original success/failure outcome with a save-failure
notice. The gateway defaults to a 16 MiB hard output limit; the library keeps 256 KiB.

Infrastructure diagnostics are delivered to the SDK server's host-side `onerror`
callback with their original cause. If that synchronous callback throws, the
controlled public failure is preserved; the callback's private
message is not sent to the MCP client. Cancellation of an MCP request can prevent
delivery of its final response even though worker cleanup still completes.

### Stdio application

See the [gateway guide](../packages/gateway/README.md) for commands, configuration,
authentication headers, and the complete client → gateway → upstream example.

The application validates its configuration and connects stdio or Streamable HTTP
upstreams using the SDK's default legacy handshake. `mcp.servers` configuration exposes
discovery while independent upstreams connect, retaining partial availability. Its stdio entry
supports both legacy and modern MCP negotiation through `serveStdio`. The input
transport starts while upstream setup is pending, so EOF also cancels initialization
and discovery. EOF, SIGINT, and SIGTERM request shutdown. Cleanup awaits every
created server instance. Stdio cleanup also awaits the actual upstream child close
event, including after failed setup or an SDK-initiated teardown. HTTP cleanup
requests session deletion when a session ID exists, then closes the transport.
The DELETE request is bounded at 5 seconds, and an upstream that declines session
termination with HTTP 405 is handled by the SDK.

`gw serve` also hosts authenticated loopback Streamable HTTP MCP. One daemon owns
the gateway; its independent MCP sessions share that gateway's executor and upstreams.
Native Codex/Claude clients use the `/mcp` URL directly, without a bridge. A client
DELETE retires only its own session; open HTTP requests/event streams retain the
session, and disconnected sessions receive a 60-second grace. Closing clients does
not stop the HTTP process. Installation, process supervision, and client configuration
are user-managed; there is no custom installer or `gw service` command. HTTP serving
and live `doctor` checks use a user-supplied persistent `GW_HTTP_TOKEN`; it is never
generated or saved by the gateway. Restarting does not revoke an unchanged token.
See [local deployment](local-installation.md) for rotation, migration, and the local
port-impersonation limitation.

Startup budgets are separate from execution budgets. The gateway uses the same
`SandboxLimits` upper bounds as constructor and worker-boundary validation, with
different default execution deadlines. Configuration files are read once; named
catalogs are republished after connection/authentication recovery. Each execution
retains its catalog and connection leases through settlement. One long-lived
`CodeExecutor` serves all catalog snapshots and MCP instances created by a `Gateway`.
Its admission budget includes actual worker exit after failed termination.
Separate gateways/processes remain independent.

The CLI resolves an explicit config path before XDG (`$XDG_CONFIG_HOME/codemode-mcp-gateway/config.json`,
otherwise `~/.config/codemode-mcp-gateway/config.json`) and never implicitly loads cwd configuration.
`check` validates offline, `doctor` reads the actual daemon (`doctor --stdio` explicitly
opens fresh diagnostic connections), and named
`login`/`logout` manage OS credentials. A running named gateway detects newly saved
authorized credentials and recreates affected upstream sessions without restarting
the agent-facing connection. Unchanged failed grants are not refreshed repeatedly.
Pre-exchange setup failures retry with backoff; transient credential-read failures
on active sessions leave those sessions usable by subsequent executions. Failed
token exchanges or persistence after rotation are not retried with unchanged grants.
An established HTTP session returning 404 is retired and reinitialized for later
executions without replaying the failed call. An explicit fresh doctor probe emits its final report only
after connection cleanup succeeds; cleanup errors produce a single failure result.
See the [gateway guide](../packages/gateway/README.md#named-upstreams-and-hot-recovery)
for recovery timing and status.

## Architecture

**Host** is the Bun main thread holding callbacks and call records. **Worker** is
the separate Bun thread running QuickJS. **Guest** is submitted JavaScript inside
that VM, not the privileged worker code.

```text
Host: fixed policy + execution-local tools -> worker supervision -> callback dispatch and reports
  ↕ worker messages: call IDs, names, JSON payloads; shared interrupt flag
Worker: startup validation -> VM/bridge setup -> guest job pump and deadline
  ↕ private functions: serialized call and reply envelopes
Guest: prelude-owned promises -> submitted async function -> tools[name](args)
```

Read the lifecycle explanations beside the implementation:

- [Supervisor](../packages/codemode/src/runtime/execution.ts): first outcome, call snapshot, worker cleanup.
- [Engine](../packages/codemode/src/runtime/engine.ts): VM ownership, job pumping, completion, guest deadline.
- [Guest bridge](../packages/codemode/src/runtime/guest-bridge.ts): admission, settlement, wakeups, private failures.
- [MCP server](../packages/mcp/src/server.ts): borrowed executor, response projection, active request cleanup.
- [Gateway](../packages/gateway/src/server.ts): upstream setup, process signals, stdio/HTTP shutdown.

Package responsibilities and composition are covered in the [package guides](../README.md#packages).

A tool call travels up and its reply travels back down:

```text
guest: tools.add(args) -> serialize arguments, assign call ID, create guest promise
       -> private dispatch(JSON call envelope)
worker: validate envelope/name/ID, admit call, post tool-call { callId, name, argsJson }
main: decode and parse arguments once, validate the call, record dispatch,
      invoke callback(args, { signal }), serialize the ToolResult,
      record completed response, post tool-result { callId, result }
worker: decode reply, validate outstanding ID, call private settle(JSON reply envelope)
guest: resolve/reject the stored promise
worker: release the call slot and wake the engine
worker: pump QuickJS jobs -> prelude decodes the result -> guest resumes
```

Execution report flow:

```text
parent accepts completion / cancellation / timeout / infrastructure failure
  -> close dispatch and snapshot call outcomes
       recorded responses -> completed
       unresolved dispatched calls -> interrupted with the selected reason
  -> request interruption; abort tool signal on unsuccessful execution
  -> await worker cleanup
        expected outcome -> return { result, calls }
       infrastructure or cleanup failure -> reject SandboxExecutionError(calls, cause)
```

### Ownership

| Owner                        | Resources                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `CodeExecutor`               | Fixed resource limits and snapshotted callback bindings                             |
| `WorkerExecution`            | Worker, listeners, parent timer/interrupt flag, tool abort controller, call records |
| Worker entry's cleanup stack | Transport listeners                                                                 |
| Engine                       | QuickJS context and runtime, deadline, and bridge scope                             |
| Guest bridge                 | Borrows the context; scope owns dispatcher/settlement handles; tracks admitted IDs  |
| Guest prelude                | Ordinary guest promises and their resolver map, released with the VM                |
| Main app's catalog           | Callback bindings and metadata; no VM or worker resources                           |

- On normal scope exit or unwinding, `using` disposes resources in reverse declaration order.
  QuickJS handles point into WASM memory; host garbage collection does not
  release them. Forced worker termination may skip this worker-side cleanup.
- `createVm` transfers the context, which owns its runtime, only after setup
  succeeds by moving its cleanup stack. Failed setup disposes the context; if disposal
  also fails, a `SuppressedError` retains both failures.
- Only the native dispatcher and private settlement handle have execution-long
  ownership in the bridge `Scope`. Per-call promises and resolvers remain inside
  QuickJS, not native deferred handles or worker-side reply promises. Settlement
  checks that the scope is alive before touching the VM, so late host completions
  never access a closed VM.
- Error reporting borrows the thrown handle and disposes only owned promise-state
  handles; the SDK's `dump` consumes promise handles.
- The supervisor removes message, message-error, and exit listeners before
  terminating the worker. If termination rejects while the worker remains alive,
  its error listener stays until actual exit, alongside the capacity reservation.
  Late errors cannot become unhandled EventEmitter errors. Partial setup unwinds.
- The guest bridge's `pendingCalls` tracks both active and queued admitted IDs until replies are settled;
  `failure` records the first private infrastructure failure or admission limit (`kind`
  `error` or `limit`; undefined while healthy) and `failureSignal`
  wakes the engine. A renewable `changeSignal` wakes an idle engine after successful
  settlement, without a worker-side promise for each call. Decoding successful
  values runs on the guest job queue after releasing the call slot: then getters
  on decoded objects can start other calls without retaining the completed slot.

## Contracts

### Results and failures

- Expected outcomes resolve in `report.result`; see the [result kinds](../packages/codemode/README.md#results-and-failures).
  Thrown strings become the message; other values without a string `message`
  produce a generic message. Thrown
  promises are opaque values, not awaited or unwrapped.
- Only deliberately public tool-failure messages cross into the guest.
  Exceptions thrown by a callback become `Host tool failed.` without exposing
  private messages or stacks. Scripts can catch tool rejections and continue.
  `ToolResult.failure(message, { cause })` attaches a host-only diagnostic cause
  without changing the public guest rejection. The optional `onToolException`
  observer receives thrown or attached causes, call ID, and tool name while the
  execution is running; an observer exception is an infrastructure failure.
- Infrastructure failures reject the host promise and never become catchable tool
  failures: parser and VM allocation/settlement failures, protocol violations,
  transport failures, worker crashes, and premature exit. They are not retried
  against the VM.
- Within the worker, infrastructure failures keep their original cause. Across the
  worker boundary, the worker sends only a controlled failure category and the
  supervisor uses a new controlled error as `SandboxExecutionError.cause`; worker
  exception messages, stacks, and identity are not transferred. Local registry,
  construction, transport, and termination failures retain their identity in the
  host-only cause instead of being forwarded to the guest.
- Synchronous guest-bridge exceptions are recorded before the SDK can turn them
  into catchable guest errors. The interrupt handler observes the failure, and the
  engine checks it after guest execution, job pumping, and error conversion, so
  guest `try/catch`, loops, or error getters cannot replace it with a script result.

### JSON conversion

Arguments, tool results, and return values cross through JSON, so objects and
executable methods are never shared between host and guest.

- Native semantics apply: undefined object properties are omitted; undefined array
  entries and non-finite numbers become null. An absent or undefined return
  becomes null; an undefined tool result stays undefined.
- Guest return values and arguments convert inside the VM, including getters and
  `toJSON`. The prelude captures native JSON functions before user code runs, so
  guest mutation of `JSON` or `Promise.prototype.then` does not affect conversion.
- Tool names and public failure messages enter the VM through JSON envelopes:
  the pinned SDK's raw string constructor truncates at NUL. Thrown primitive strings
  use a captured JSON encoder before crossing back, preserving their full content
  for output-size measurement.
- Tool results convert on the main thread. Throwing getters or `toJSON` hooks and
  unsupported values produce the public `Tool result is not JSON-serializable.`
- BigInt, circular values, and unsupported top-level values fail as script errors.
  Unsupported tool arguments fail before dispatch.
- Promise and thenable returns are awaited with native guest semantics.

### Completion and deadline

- Successful scripts wait for active and queued host calls and queued guest jobs,
  including unawaited calls, race losers, and calls started by `toJSON`. Awaiting
  one promise twice does not dispatch twice; `Promise.race` does not cancel losers.
- Draining calls is not proof that they succeeded: unhandled tool rejections
  follow native promise semantics and are not audited.
- A pending guest promise with no queued jobs or host calls fails explicitly
  instead of hanging.
- An uncaught script failure or timeout ends execution without waiting for
  unrelated callbacks. Late results are dropped before conversion or posting.
- When `timeoutMs` is configured, one monotonic deadline covers source validation, prelude setup, execution, guest
  jobs, host waits, and error conversion (including guest getters and `toJSON`).
  It starts after worker startup, WASM loading, VM creation,
  and tool installation. A worker timer wakes idle execution; the QuickJS interrupt
  handler stops running guest computation. Without a configured deadline there is
  no expiration timer; caller cancellation still interrupts the worker.

### Parent-supervised deadline

`totalTimeoutMs` records a fresh monotonic deadline after admission and tool snapshotting,
before worker construction. Default bindings are copied at construction; supplied
execution bindings are copied at admission. Both are outside execution deadlines.
Every execution has a parent-owned one-word shared interrupt
flag; the total budget adds a parent timer. The flag is supplied only to trusted worker
code; it is never exposed to the guest.

```text
admit source/execution -> snapshot tools -> record parent deadline -> construct worker -> supervise
  -> on messages and callback settlements: check the clock before continuing
  -> on expiry: select total-timeout result, close dispatch/call snapshot, set shared flag
  -> clear parent timer, remove normal listeners, request worker termination
  -> await termination, remove error listener, return report (or reject cleanup failure with calls)
```

- Checking the clock during message handling prevents a queued completion or call
  from winning just because the timer callback has not run yet. Decoding and host
  result conversion are checked afterward too, because synchronous work can overrun.
- An outcome accepted before expiry remains final even if termination finishes
  after the deadline. Late replies and worker events cannot replace it.
- The QuickJS interrupt handler reads the flag with `Atomics.load`, so it can
  observe parent interruption during synchronous guest computation without waiting
  for a port message. An idle worker is shut down through termination.
- Bun exposes `worker.terminate()`, not a public shared interrupt flag; the shared
  flag here belongs to this application. In the pinned Bun version, termination
  requests a native VM stop and its promise is tied to the worker's `close` event.
  Neither a hard shutdown latency nor execution of worker-side cleanup is promised.

### Cancellation and cleanup ordering

```text
already aborted -> return cancelled report with no calls
otherwise -> admit source -> create worker -> supervise
caller abort -> check total deadline, choose timeout or cancelled outcome
  -> close dispatch and call snapshot -> set shared interrupt flag -> abort host-tool signal
  -> remove caller/worker listeners and timer -> terminate worker
  -> await termination -> remove worker error listener -> return report
```

- A pre-aborted execution skips source admission, reading supplied tools, and worker
  creation. Default tool bindings were already snapshotted during construction.
- The first accepted outcome wins. If the total deadline has already elapsed when
  cancellation is observed, the result is `timeout`; otherwise it is `cancelled`.
  Later cancellation cannot replace a completed result or infrastructure failure.
- Tool abort listeners run synchronously, so the supervisor closes dispatch and
  selects its outcome before notifying them. Reentrant calls and late results are
  discarded. A guest cannot catch caller cancellation and keep the execution alive.
- Caller reasons are never inspected, serialized, or passed to tools. Tools receive
  a generic `AbortError`; the worker receives only the shared interrupt flag.
- Cleanup removes the caller's abort listener on success, cancellation, and failure,
  including partial registration. Termination failure still rejects the host promise.
- A synchronous main-thread callback, conversion, or tool abort listener can delay
  cancellation and cleanup. There is no hard cancellation-latency guarantee.

### Guest boundary

Trusted setup and submitted code are compiled separately inside QuickJS:

```text
validate the complete async function wrapper with Acorn
  -> evaluate the trusted prelude factory
  -> factory captures one native dispatcher and publishes only wrapped tools
  -> compile the validated user function in the VM's global scope
  -> private runner calls that function with tools and serializes its result
```

The user function cannot reach the raw dispatcher, resolver map, captured JSON
functions, or private `run`/`settle` API through lexical scope, `eval`, or dynamic
function constructors.

Acorn checks that the source is exactly the intended async arrow function with its
body boundaries intact. It does not rewrite the program or impose a JavaScript
subset. The check is necessary because QuickJS's native async-function constructor
accepted a wrapper-escape payload and dispatched a tool while constructing the
function. Malformed bodies fail before any user code or host call executes.

Guest built-ins remain mutable. VM-local `eval`/`Function`, closures, classes,
generators, and the guest-global `this` binding remain supported.

The prelude captures the promise/error constructors, JSON functions, map methods,
`Reflect.apply`, and `Object.create` before submitted code runs. It does not freeze
built-ins. Private call envelopes and resolver records use null prototypes so
guest-inherited `toJSON` hooks cannot rewrite the protocol or expose its records;
ordinary argument and result conversion still observes native guest semantics.

### Guest protocol

- One native dispatcher receives JSON text describing `{ type: "call", callId,
  name, argsJson }`. The worker validates the envelope, known name, increasing ID,
  and argument JSON before dispatch. Invalid messages end execution rather than
  becoming catchable tool failures.
- The worker calls a private settlement function with JSON text describing
  `{ type: "result", callId, result }`. Success contains `json`; failure contains
  only an explicit public `error.message`.
- `argsJson` and successful `json` use JSON null for absent text. The string
  `"null"` represents the actual JSON null value. The worker/host protocol retains
  its existing `undefined` representation.
- The native dispatcher returns whether dispatch succeeded. Rejected calls do not
  remain in the prelude's resolver map; terminal admission/infrastructure failures
  are still selected by the worker's checkpoint and interrupt handler.
- Transport dispatch must not synchronously re-enter the VM. Production replies
  arrive through parent-port events; the local test adapter defers delivery.

### Worker protocol

- Startup data and both message directions have typed decoders that accept
  `unknown` and return explicit success/failure unions. Structured cloning carries
  envelopes, JSON text/derived result data, resolved limits, and the shared interrupt buffer;
  no VM handles or functions cross threads. The buffer must contain one 32-bit word.
- Only the parent classifies caller cancellation and source/execution admission; workers
  cannot report either outcome.
- JSON text is validated before dispatch or guest settlement. The main thread
  parses tool arguments once while decoding.
- Per-execution call IDs increase in dispatch order. The main thread rejects
  unknown tool names and invalid or replayed call IDs. Replies may complete out of
  order; the worker rejects unknown or duplicate replies.
- The first execution outcome wins; duplicate or late events do not resettle it.
  The supervisor awaits worker termination on success and failure, and termination
  failures reject the host promise.

## Limitations

- This is thread separation, not an OS or process sandbox. The trusted worker has
  Bun privileges; guest code runs only inside QuickJS.
- Guest limits do not bound total host/WASM memory or the full report's size.
  Execution concurrency is bounded per executor, not across the process or separate
  gateway instances. See [resource limits](#resource-limits) for exact coverage.
- There is no worker pool: each execution pays worker startup and QuickJS loading.
- Worker startup is covered only when `totalTimeoutMs` is supplied. Without it,
  a stuck worker that neither reports nor exits can leave execution pending.
  The caller can cancel with `AbortSignal`, but there is no hard response-latency
  guarantee; shutdown still depends on Bun's termination behavior.
- Synchronous host callbacks and result conversion run on the main thread and cannot
  be interrupted. The guest deadline checks source parsing after it returns;
  the parent can request worker termination meanwhile.
- Cancellation provides no rollback, automatic retry, or exactly-once guarantee.
  Tool payloads and their temporary host/transport allocations remain unbounded by sandbox policy.
- No guest imports, TypeScript, or persistent state. MCP integration currently
  adapts tools from one application-owned client per catalog.
- This is a learning project, not a production-hardened sandbox.

## Code style and checks

See [project conventions](../AGENTS.md) for code, comment, and ownership rules,
and [testing conventions](testing.md) for package ownership, fault injection,
async ordering, and focused commands. Root `bun run check` builds, typechecks,
lints, checks formatting, runs package tests, and verifies packed consumers.
