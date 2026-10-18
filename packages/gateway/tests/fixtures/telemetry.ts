import { Configuration, Gateway, Logger, Telemetry } from "codemode-mcp-gateway";
import { connect } from "../support/gateway.ts";

async function run() {
  const logger = await Logger.fromEnvironment();
  await using telemetry = await Telemetry.fromEnvironment(logger);

  await using gateway = new Gateway(
    Configuration.parse({
      mcp: { servers: { paused: { type: "local", command: ["unused"], disabled: true } } },
    }),
    ".",
    { logger, ...(telemetry === undefined ? {} : { telemetry }) },
  );

  await gateway.start();
  await using agent = await connect(gateway.createServer());
  await agent.client.callTool({
    name: "execute",
    arguments: { code: 'return "private-code-and-result";' },
  });
}

try {
  await run();
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : "Telemetry fixture failed.");
  process.exitCode = 1;
}
