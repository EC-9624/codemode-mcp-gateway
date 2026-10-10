import { Parser } from "acorn";

// Fault injection is confined to this disposable worker, never the host's parser.
Parser.parse = () => {
  throw new Error("Private parser infrastructure details");
};

// A static import would start execution before the parser fault is installed.
await import("../../src/worker-entry");
