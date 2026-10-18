import { deepEqual, equal } from "node:assert/strict";
import { z } from "zod";
import { Configuration, Gateway, fileCredentialStore, login, logout } from "codemode-mcp-gateway";
import { connect } from "../support/gateway.ts";
import { responseValue } from "../support/output.ts";

const operation = z.enum(["login", "call", "logout", "load"]).parse(process.argv[2]);
const path = z.string().parse(process.argv[3]);
const config = Configuration.parse(await Bun.file(path).json());

if (operation === "login") {
  deepEqual(
    await login(path, {
      authorize: async (url) => {
        const response = await fetch(url);
        equal(response.ok, true);
        await response.body?.cancel();
      },
    }),
    { ok: true, value: undefined },
  );
  console.log("logged in");
}

if (operation === "call") {
  await using gateway = new Gateway(config, ".");
  await gateway.start();
  deepEqual(
    gateway.status().map((server) => server.state),
    ["connected"],
  );
  await using agent = await connect(gateway.createServer());

  const result = await agent.client.callTool({
    name: "execute",
    arguments: { code: 'return (await tools["notes.add"]({ a: 2, b: 3 })).structuredContent.sum;' },
  });

  equal(responseValue(result), 5);
  console.log("called");
}

if (operation === "logout") {
  deepEqual(await logout(path), { ok: true, value: undefined });
  console.log("logged out");
}

if (operation === "load") {
  const server = config.mcp.servers.notes;
  if (server?.type !== "remote") throw new Error("Expected a remote notes server.");

  const result = await fileCredentialStore({ id: "notes", url: server.url }).load();
  console.log(JSON.stringify(result));
}
