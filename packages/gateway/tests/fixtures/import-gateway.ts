import { deepEqual, equal } from "node:assert/strict";

const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
const exitCode = process.exitCode;

const { createServer, serve, login, logout, Credentials, AuthorizationError } =
  await import("codemode-mcp-gateway");

equal(typeof createServer, "function");
equal(typeof serve, "function");
equal(typeof login, "function");
equal(typeof logout, "function");
equal(typeof Credentials.safeParse, "function");
equal(
  new AuthorizationError({ kind: "required", message: "Login required" }).message,
  "Login required",
);
equal(process.exitCode, exitCode);
deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], listeners);
console.log("gateway-imported");
