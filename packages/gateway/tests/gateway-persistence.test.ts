import { describe, expect, test } from "bun:test";
import { Configuration, Gateway, login, type CredentialStore } from "codemode-mcp-gateway";
import { configurationDocument } from "./support/configuration.ts";
import { connect, within } from "./support/gateway.ts";
import { memoryCredentials, oauthFixture } from "./support/oauth.ts";
import { responseText, responseValue } from "./support/output.ts";

describe("gateway OAuth persistence rejection", () => {
  test.each([
    { name: "rotated-token save", error: undefined },
    { name: "invalid-grant save", error: "invalid_grant" },
    { name: "invalid-client clear", error: "invalid_client" },
  ])("a rejected $name blocks the snapshot until a new login", async ({ error }) => {
    await using upstream = await oauthFixture({
      refresh: async () =>
        error === undefined ? undefined : Response.json({ error }, { status: 400 }),
    });

    const memory = memoryCredentials();
    const failure = new Error("Private credential persistence failure");
    let rejectPersistence = false;

    const store: CredentialStore = {
      ...memory.store,
      async save(record) {
        if (rejectPersistence) throw failure;

        return memory.store.save(record);
      },
      async clear() {
        if (rejectPersistence) throw failure;

        return memory.store.clear();
      },
    };

    const input = { mcp: { servers: { notes: { type: "remote", url: upstream.url, oauth: {} } } } };
    await using file = await configurationDocument(input);

    const options = {
      store: () => store,
      lockDirectory: upstream.lockDirectory,
      authorize: async (url: URL) => {
        await fetch(await upstream.authorize(url));
      },
    };

    expect(await login(file.path, options)).toEqual({ ok: true, value: undefined });
    const blocked = Promise.withResolvers<void>();
    const recovered = Promise.withResolvers<void>();
    const exceptions: unknown[] = [];
    let connections = 0;

    await using gateway = new Gateway(Configuration.parse(input), ".", {
      ...options,
      onToolException: (exception) => exceptions.push(exception.cause),
      onStatus: (status) => {
        if (status.state === "needs-auth") blocked.resolve();

        if (status.state === "connected" && ++connections === 2) recovered.resolve();
      },
    });

    await gateway.start();
    await using agent = await connect(gateway.createServer());
    using faults = new DisposableStack();
    faults.defer(() => {
      rejectPersistence = false;
    });
    rejectPersistence = true;
    upstream.rejectAccess();

    const failed = await agent.client.callTool({
      name: "execute",
      arguments: { code: 'return await tools["notes.add"]({ a: 1, b: 2 });' },
    });

    expect(failed.isError).toBe(true);
    expect(responseText(failed)).toContain("Host tool failed.");
    expect(responseText(failed)).not.toContain(failure.message);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toBe(failure);
    await within(blocked.promise, 500);

    const waiting = await agent.client.callTool({
      name: "execute",
      arguments: {
        code: 'return (await tools.searchTools({ query: "add", server: "notes" })).servers[0].state;',
      },
    });

    expect(responseText(waiting)).toBe("needs-auth");
    expect(upstream.refreshes).toBe(1);
    expect(gateway.status()).toMatchObject([{ state: "needs-auth", error: { kind: "storage" } }]);

    rejectPersistence = false;
    expect(await login(file.path, options)).toEqual({ ok: true, value: undefined });
    await within(recovered.promise);

    const response = await agent.client.callTool({
      name: "execute",
      arguments: {
        code: 'return (await tools["notes.add"]({ a: 2, b: 3 })).structuredContent.sum;',
      },
    });

    expect(responseValue(response)).toBe(5);
    expect(upstream.refreshes).toBe(1);
  });
});
