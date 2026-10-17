import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "./mcp-tools.ts";

serveStdio(createMcpServer);
