/** Stable usage guidance; live tool availability belongs in discovery results. */
export const executionInstructions = `Run JavaScript that discovers and calls tools, combines their results, and returns useful JSON. The tools and discovery helpers below are available only inside execute; tools from the caller's other tool catalogs are not available here.

## Workflow
1. Discover by intent and key nouns, for example: \`return await tools.searchTools({ query: "records" });\`
   Returns { tools, total, nextOffset }: five ranked name/description previews by default. Use limit and offset to paginate; nextOffset is null at the end.
2. Inspect a match with \`await tools.describeTool({ name })\` for its full description and inputSchema. Use exact discovered names and arguments matching the schema; do not invent or normalize names.
3. Tool names are qualified as "server.original-name". Call with \`await tools[name](args)\`, using the complete name as one key. Upstream tools return { content, structuredContent?, isError? }; check isError before treating a resolved response as success. Rejected calls can be handled with try/catch.
4. Await every call whose result or completion matters. Use Promise.allSettled for independent calls and inspect each outcome. Filter large results in code and explicitly return the JSON value the caller needs.

## Runtime
The code is an async function body in a fresh QuickJS sandbox: top-level await and return work. Use JavaScript, not TypeScript. State does not persist between executions.
Only injected tools provide external access; fetch, filesystem, process, and imports are unavailable. Execution and tool-call limits are host-owned; discovery calls count toward the tool-call budget.
The response contains only the returned value or error message. Large output shows a beginning/end preview and a local file path; use the caller's native file or shell tools to inspect the full output. The caller and gateway must share filesystem access. Output files last until gateway shutdown. Tool calls are not rolled back when a later call fails; do not blindly replay a script that may have performed writes.

## Availability
searchTools also accepts an optional server filter and returns a servers availability snapshot. Inspect it when expected tools are missing; healthy servers remain usable while others connect or recover.
Discovery and tool bindings stay fixed within an execution. After connection or credential recovery, use a new execution to discover the updated catalog. When authorization requires login, report the supplied login instruction to the user. Recovery does not replay failed scripts or calls.`;
