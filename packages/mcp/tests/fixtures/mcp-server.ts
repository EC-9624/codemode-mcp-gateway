import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "./mcp-tools.js";

serveStdio(createMcpServer);
