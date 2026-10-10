import { Parser } from "acorn";

// Fault injection is confined to this disposable worker, never the host's parser.
Parser.parse = () => {
  throw new Error("Private parser infrastructure details");
};

// Load the real entry only after installing the worker-local fault.
await import("../../src/worker-entry");
