import { deepEqual, equal } from "node:assert/strict";

const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
const exitCode = process.exitCode;
const { createServer, serve } = await import("codemode-mcp-gateway");

equal(typeof createServer, "function");
equal(typeof serve, "function");
equal(process.exitCode, exitCode);
deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], listeners);
console.log("gateway-imported");
