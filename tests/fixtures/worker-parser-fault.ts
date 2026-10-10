import { Parser } from "acorn";

// Fault injection is confined to this disposable worker, never the host's parser.
Parser.parse = () => {
  throw new Error("Private parser infrastructure details");
};
