import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { chmod, copyFile, mkdir, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";
import { configuration } from "./support/configuration.ts";

describe("Notion validation example", () => {
  test("validates the expected page and marker on repeated runs, then observes clean exit", async () => {
    const page = "11111111-1111-4111-8111-111111111111";
    const server = new McpServer({ name: "notion-fixture", version: "0" });
    const queries: string[] = [];
    const fetched: string[] = [];
    server.registerTool(
      "notion-search",
      { inputSchema: z.object({ query: z.string() }) },
      ({ query }) => {
        queries.push(query);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                type: "workspace_search",
                results: [
                  { id: page, title: "Synthetic design doc", url: `https://www.notion.so/${page}` },
                ],
              }),
            },
          ],
        };
      },
    );
    server.registerTool("notion-fetch", { inputSchema: z.object({ id: z.string() }) }, ({ id }) => {
      fetched.push(id);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              title: "Synthetic design doc",
              url: `https://www.notion.so/${page}`,
              text: "private page body: expected marker",
            }),
          },
        ],
      };
    });
    await using upstream = await httpServer(server);
    await using config = await configuration({ type: "remote", url: upstream.url }, "notion");

    const result = await runExample([
      config.path,
      "design",
      "--page",
      page,
      "--expect",
      "expected marker",
      "--runs",
      "2",
    ]);

    expect(result.code).toBe(0);
    expect(queries).toEqual(["design", "design"]);
    expect(fetched).toEqual([page, page]);
    expect(result.records.filter((record) => record.step === "fetch")).toMatchObject([
      {
        status: "passed",
        iteration: 1,
        summary: { markerChecked: true },
      },
      {
        status: "passed",
        iteration: 2,
        summary: { markerChecked: true },
      },
    ]);
    expect(result.records.at(-1)).toMatchObject({
      step: "shutdown",
      status: "passed",
      code: 0,
      signal: null,
    });
    expect(upstream.methods).toContain("DELETE");
    expect(result.stdout).not.toContain("private page body");
  });

  test("accepts an empty search when no expected page was supplied", async () => {
    const server = new McpServer({ name: "notion-fixture", version: "0" });
    server.registerTool("notion-search", { inputSchema: z.object({ query: z.string() }) }, () => ({
      content: [{ type: "text", text: JSON.stringify({ type: "workspace_search", results: [] }) }],
    }));
    await using upstream = await httpServer(server);
    await using config = await configuration({ type: "remote", url: upstream.url }, "notion");

    const result = await runExample([config.path, "no matches"]);

    expect(result.code).toBe(0);
    expect(result.records.find((record) => record.step === "search")).toMatchObject({
      status: "passed",
      summary: { results: 0 },
    });
  });

  test("the copied Notion client and its helpers run outside the checkout with an explicit gateway", async () => {
    const server = new McpServer({ name: "notion-fixture", version: "0" });
    server.registerTool("notion-search", { inputSchema: z.object({ query: z.string() }) }, () => ({
      content: [{ type: "text", text: JSON.stringify({ type: "workspace_search", results: [] }) }],
    }));
    await using upstream = await httpServer(server);
    await using config = await configuration({ type: "remote", url: upstream.url }, "notion");
    const directory = join(dirname(config.path), "external consumer");
    await mkdir(directory);
    for (const name of ["notion-client.ts", "readiness.ts", "output.ts"])
      await copyFile(
        fileURLToPath(new URL(`../examples/${name}`, import.meta.url)),
        join(directory, name),
      );

    await symlink(
      fileURLToPath(new URL("../../../node_modules", import.meta.url)),
      join(directory, "node_modules"),
      "dir",
    );
    const gateway = join(directory, "gw");
    // Wrap the real source CLI only to select development exports. The packed
    // consumer verifier separately owns compiled-executable behavior.
    await Bun.write(
      gateway,
      '#!/bin/sh\nexec "$EXAMPLE_BUN" --conditions=development "$EXAMPLE_CLI" "$@"\n',
    );
    await chmod(gateway, 0o755);

    const result = await runExample([config.path, "no matches", "--gateway", gateway], {
      entry: join(directory, "notion-client.ts"),
      cwd: directory,
      environment: {
        EXAMPLE_BUN: process.execPath,
        EXAMPLE_CLI: fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
      },
    });

    expect(result.code).toBe(0);
    expect(result.records.find((record) => record.step === "search")).toMatchObject({
      status: "passed",
      summary: { results: 0 },
    });
    expect(result.records.at(-1)).toMatchObject({ step: "shutdown", status: "passed", code: 0 });
    expect(upstream.methods).toContain("DELETE");
  });

  test.each([
    {
      name: "upstream error",
      response: {
        isError: true,
        content: [{ type: "text" as const, text: "private provider diagnostic" }],
      },
      kind: "upstream",
    },
    {
      name: "malformed JSON",
      response: {
        isError: false,
        content: [{ type: "text" as const, text: "private provider diagnostic" }],
      },
      kind: "validation",
    },
    {
      name: "unexpected JSON structure",
      response: {
        isError: false,
        content: [{ type: "text" as const, text: '{"unexpected":"private provider diagnostic"}' }],
      },
      kind: "validation",
    },
  ])(
    "fails on $name without exposing provider bodies or starting another run",
    async ({ response, kind }) => {
      const server = new McpServer({ name: "notion-fixture", version: "0" });
      let calls = 0;
      server.registerTool("notion-search", { inputSchema: z.object({ query: z.string() }) }, () => {
        calls++;

        return { isError: response.isError, content: [...response.content] };
      });
      await using upstream = await httpServer(server);
      await using config = await configuration({ type: "remote", url: upstream.url }, "notion");

      const result = await runExample([config.path, "design", "--runs", "2"]);

      expect(result.code).toBe(1);
      expect(calls).toBe(1);
      expect(result.records.find((record) => record.step === "search")).toMatchObject({
        status: "failed",
        kind,
      });
      expect(result.records.at(-1)).toMatchObject({
        step: "shutdown",
        status: "passed",
        code: 0,
        signal: null,
      });
      expect(result.stdout + result.stderr).not.toContain("private provider diagnostic");
    },
  );

  test.each([
    {
      name: "missing marker",
      url: "https://www.notion.so/11111111-1111-4111-8111-111111111111",
      text: "different content",
      message: "Expected marker was absent from the fetched page.",
    },
    {
      name: "wrong page",
      url: "https://www.notion.so/22222222-2222-4222-8222-222222222222",
      text: "expected marker",
      message: "Fetch returned a different page.",
    },
  ])("rejects a fetched page with $name", async ({ url, text, message }) => {
    const page = "11111111-1111-4111-8111-111111111111";
    const server = new McpServer({ name: "notion-fixture", version: "0" });
    server.registerTool("notion-search", { inputSchema: z.object({ query: z.string() }) }, () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            type: "workspace_search",
            results: [
              { id: page, title: "Synthetic design doc", url: `https://www.notion.so/${page}` },
            ],
          }),
        },
      ],
    }));
    server.registerTool("notion-fetch", { inputSchema: z.object({ id: z.string() }) }, () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            title: "Synthetic design doc",
            url,
            text,
          }),
        },
      ],
    }));
    await using upstream = await httpServer(server);
    await using config = await configuration({ type: "remote", url: upstream.url }, "notion");

    const result = await runExample([
      config.path,
      "design",
      "--page",
      page,
      "--expect",
      "expected marker",
    ]);

    expect(result.code).toBe(1);
    expect(result.records.find((record) => record.step === "fetch")).toMatchObject({
      status: "failed",
      kind: "validation",
      message,
    });
  });

  test("stops before fetch when search does not find the expected page", async () => {
    const page = "11111111-1111-4111-8111-111111111111";
    const server = new McpServer({ name: "notion-fixture", version: "0" });
    server.registerTool("notion-search", { inputSchema: z.object({ query: z.string() }) }, () => ({
      content: [{ type: "text", text: JSON.stringify({ type: "workspace_search", results: [] }) }],
    }));
    let fetches = 0;
    server.registerTool("notion-fetch", { inputSchema: z.object({ id: z.string() }) }, () => {
      fetches++;

      return { content: [] };
    });
    await using upstream = await httpServer(server);
    await using config = await configuration({ type: "remote", url: upstream.url }, "notion");

    const result = await runExample([config.path, "design", "--page", page]);

    expect(result.code).toBe(1);
    expect(fetches).toBe(0);
    expect(result.records.find((record) => record.step === "search")).toMatchObject({
      status: "failed",
      kind: "validation",
      message: "Expected page was not in the first 10 search results. Use a more specific query.",
    });
  });

  test("rejects an unbounded repeat count before opening a gateway", async () => {
    const result = await runExample(["unused.json", "design", "--runs", "21"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage:");
  });

  test("fails schema validation before calling an incompatible search tool", async () => {
    const server = new McpServer({ name: "notion-fixture", version: "0" });
    let calls = 0;
    server.registerTool("notion-search", { inputSchema: z.object({ query: z.number() }) }, () => {
      calls++;

      return { content: [] };
    });
    await using upstream = await httpServer(server);
    await using config = await configuration({ type: "remote", url: upstream.url }, "notion");

    const result = await runExample([config.path, "design"]);

    expect(result.code).toBe(1);
    expect(calls).toBe(0);
    expect(result.records.find((record) => record.step === "describe:notion-search")).toMatchObject(
      { status: "failed", kind: "validation" },
    );
  });

  test("reports startup failure and the gateway's unsuccessful exit", async () => {
    const missing = fileURLToPath(
      new URL("./fixtures/missing-configuration.json", import.meta.url),
    );

    const result = await runExample([missing, "design"]);

    expect(result.code).toBe(1);
    expect(result.records.find((record) => record.step === "startup")).toMatchObject({
      status: "failed",
      kind: "transport",
    });
    expect(result.records.at(-1)).toMatchObject({ step: "shutdown", status: "failed", code: 1 });
  });
});

async function httpServer(server: McpServer) {
  await using setup = new AsyncDisposableStack();
  setup.defer(() => server.close());

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
  });

  await server.connect(transport);
  const methods: string[] = [];

  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      methods.push(request.method);

      return transport.handleRequest(request);
    },
  });

  setup.defer(() => listener.stop(true));
  const cleanup = setup.move();

  return {
    url: new URL("/mcp", listener.url).href,
    methods,
    [Symbol.asyncDispose]: () => cleanup.disposeAsync(),
  };
}

async function runExample(
  args: string[],
  options: { entry?: string; cwd?: string; environment?: NodeJS.ProcessEnv } = {},
) {
  const entry =
    options.entry ?? fileURLToPath(new URL("../examples/notion-client.ts", import.meta.url));

  const child = Bun.spawn([process.execPath, "--conditions=development", entry, ...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: { ...process.env, ...options.environment },
    stdout: "pipe",
    stderr: "pipe",
  });

  const watchdog = setTimeout(() => child.kill(), 8_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    const records =
      stdout.trim() === ""
        ? []
        : stdout
            .trim()
            .split("\n")
            .map((line) => {
              const value: unknown = JSON.parse(line);

              return z.object({ step: z.string() }).passthrough().parse(value);
            });

    return { code, stdout, stderr, records };
  } finally {
    clearTimeout(watchdog);
    child.kill();
  }
}
