import { Logger } from "codemode-mcp-gateway";

const logger = await Logger.fromEnvironment();
const mode = process.argv[2];
if (mode === "terminal") process.stderr.isTTY = true;

let buffered = 0;
if (mode === "backpressure") {
  // Model the stream boundary only in this child, never in the shared test process.
  Object.defineProperty(process.stderr, "writableLength", { get: () => buffered });
  buffered = 65_537;
  logger.emit({
    name: "gw.service.started",
    attributes: { "gw.transport": "http", "process.pid": process.pid },
  });
  buffered = 0;
}

logger.emit({
  name: "gw.upstream.state_changed",
  attributes: {
    "gw.upstream.name": "notes\n\u001b[31mred\u001b[0m",
    "gw.upstream.state": "connected",
    "gw.upstream.tools": 2,
  },
});
