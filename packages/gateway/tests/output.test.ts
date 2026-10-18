import { describe, expect, spyOn, test } from "bun:test";
import { promises } from "node:fs";
import { dirname } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Configuration, Gateway, type ConfigurationInput } from "codemode-mcp-gateway";
import { responseText } from "./support/output.ts";
import { rejectionOf } from "./support/rejection.ts";

describe("gateway output", () => {
  test("returns exactly 40000 bytes inline without a saved-output notice", async () => {
    await using app = await outputGateway();

    const response = await app.client.callTool({
      name: "execute",
      arguments: { code: 'return "x".repeat(40000);' },
    });

    expect(response).toEqual({ content: [{ type: "text", text: "x".repeat(40000) }] });
  });

  test("spills a single-line result above the former hard limit and removes it on shutdown", async () => {
    await using app = await outputGateway();

    const response = await app.client.callTool({
      name: "execute",
      arguments: { code: 'return { text: "x".repeat(300000) };' },
    });

    const text = responseText(response);
    const path = outputPath(text);

    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toBeUndefined();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(40000);
    expect(text.startsWith('{"text":"')).toBe(true);
    expect(text).toContain("… output truncated …");
    expect(text).toContain("native file or shell tools");
    expect(await Bun.file(path).text()).toBe(JSON.stringify({ text: "x".repeat(300000) }));
    expect((await promises.stat(path)).mode & 0o777).toBe(0o600);
    expect((await promises.stat(dirname(path))).mode & 0o777).toBe(0o700);

    await app.gateway.close();

    expect(await Bun.file(path).exists()).toBe(false);
    const removed = await rejectionOf(promises.stat(dirname(path)));
    expect(removed.reason).toHaveProperty("code", "ENOENT");
  });

  test("keeps Unicode characters intact at both preview boundaries", async () => {
    await using app = await outputGateway();

    const response = await app.client.callTool({
      name: "execute",
      arguments: { code: 'return "日😀".repeat(20000);' },
    });

    const text = responseText(response);

    expect(text).not.toContain("�");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(40000);
    expect(await Bun.file(outputPath(text)).text()).toBe("日😀".repeat(20000));
  });

  test("spills large error messages without changing the failure outcome", async () => {
    await using app = await outputGateway();

    const response = await app.client.callTool({
      name: "execute",
      arguments: { code: 'throw new Error("failure ".repeat(10000));' },
    });

    expect(response.isError).toBe(true);
    expect(await Bun.file(outputPath(responseText(response))).text()).toBe(
      "failure ".repeat(10000),
    );
  });

  test.each([
    { name: "success", code: 'return "x".repeat(50000);', isError: undefined },
    { name: "failure", code: 'throw new Error("x".repeat(50000));', isError: true },
  ])("retains the preview and $name outcome when saving fails", async ({ code, isError }) => {
    await using app = await outputGateway();
    const cause = new Error("Private storage details");
    using write = spyOn(promises, "writeFile").mockRejectedValue(cause);
    const diagnostics: Error[] = [];
    app.server.server.onerror = (error) => diagnostics.push(error);

    const response = await app.client.callTool({ name: "execute", arguments: { code } });
    const text = responseText(response);

    expect(response.isError).toBe(isError);
    expect(text).toContain("… output truncated …");
    expect(text).toContain("[Full output could not be saved.]");
    expect(text).not.toContain("Private storage details");
    expect(diagnostics[0]?.cause).toBe(cause);
    expect(write).toHaveBeenCalledTimes(1);
  });

  test("gives concurrent outputs separate complete files", async () => {
    await using app = await outputGateway();

    const responses = await Promise.all([
      app.client.callTool({
        name: "execute",
        arguments: { code: 'return "first".repeat(10000);' },
      }),
      app.client.callTool({
        name: "execute",
        arguments: { code: 'return "second".repeat(10000);' },
      }),
    ]);

    const paths = responses.map((response) => outputPath(responseText(response)));

    expect(new Set(paths).size).toBe(2);
    expect(await Promise.all(paths.map((path) => Bun.file(path).text()))).toEqual([
      "first".repeat(10000),
      "second".repeat(10000),
    ]);
  });

  test("keeps an explicit hard output limit instead of silently raising it", async () => {
    await using app = await outputGateway({ maxOutputBytes: 4 });

    const response = await app.client.callTool({
      name: "execute",
      arguments: { code: 'return "too much";' },
    });

    expect(response).toEqual({
      content: [{ type: "text", text: "Output exceeds the 4 byte limit." }],
      isError: true,
    });
  });

  test("rejects serialized output above the gateway's default 16 MiB hard limit", async () => {
    await using app = await outputGateway();

    const response = await app.client.callTool({
      name: "execute",
      arguments: { code: 'return "x".repeat(16 * 1024 * 1024);' },
    });

    expect(response).toEqual({
      content: [{ type: "text", text: "Output exceeds the 16777216 byte limit." }],
      isError: true,
    });
  });

  test("waits for in-flight output writes before deleting files on gateway shutdown", async () => {
    await using app = await outputGateway();
    const saved = Promise.withResolvers<string>();
    const release = Promise.withResolvers<void>();
    using gates = new DisposableStack();
    gates.defer(() => release.resolve());
    const writeFile = promises.writeFile;

    using write = spyOn(promises, "writeFile").mockImplementation(
      async (...args: Parameters<typeof promises.writeFile>) => {
        await writeFile(...args);
        if (typeof args[0] !== "string") throw new Error("Expected an output file path.");

        saved.resolve(args[0]);
        await release.promise;
      },
    );

    // Shutdown may disconnect the client or finish delivery first; only write/cleanup ordering matters.
    const request = Promise.allSettled([
      app.client.callTool({ name: "execute", arguments: { code: 'return "x".repeat(50000);' } }),
    ]);

    const path = await saved.promise;
    let closed = false;

    const closing = app.gateway.close().then(() => {
      closed = true;
    });

    expect(await Bun.file(path).exists()).toBe(true);
    expect(closed).toBe(false);
    release.resolve();
    await closing;
    await request;

    expect(await Bun.file(path).exists()).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  });
});

function outputPath(text: string): string {
  const path = text.match(/\[Full output: ([^\n]+)\]/)?.[1];
  if (path === undefined) throw new Error("Expected a full-output path.");

  return path;
}

async function outputGateway(sandbox: ConfigurationInput["sandbox"] = {}) {
  await using setup = new AsyncDisposableStack();

  const gateway = setup.use(
    new Gateway(
      Configuration.parse({
        mcp: { servers: { unused: { type: "local", command: ["unused"], disabled: true } } },
        sandbox,
      }),
      ".",
    ),
  );

  await gateway.start();
  const server = gateway.createServer();
  const client = new Client({ name: "output-test", version: "1" });
  setup.defer(() => client.close());
  const [local, remote] = InMemoryTransport.createLinkedPair();

  await server.connect(remote);
  await client.connect(local);
  const cleanup = setup.move();

  return { gateway, server, client, [Symbol.asyncDispose]: () => cleanup.disposeAsync() };
}
