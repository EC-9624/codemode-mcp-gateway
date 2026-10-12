/** MCP adapters borrow application-owned connections and executors; they do not select a VM. */
export { createMcpCatalog } from "./catalog.js";
export { createCodemodeServer } from "./server.js";
export {
  type McpCatalogOptions,
  type CodemodeServerOptions,
  type CodemodeResponse,
  type CallSummary,
} from "./types.js";
