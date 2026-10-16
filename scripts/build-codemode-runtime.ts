import { fileURLToPath } from "node:url";

// Preserve the WASM memory-view fix in published packages: consumers do not inherit
// this workspace's Bun dependency patches. Only SDK JavaScript needs the fix;
// WASM variants stay external so their loaders can resolve their own assets.
// Remove this workaround after adopting a reviewed fixed SDK release (patches/README.md).
const result = await Bun.build({
  entrypoints: [
    fileURLToPath(new URL("../packages/codemode/src/runtime/quickjs.ts", import.meta.url)),
  ],
  outdir: fileURLToPath(new URL("../packages/codemode/dist/runtime/", import.meta.url)),
  naming: "quickjs.js",
  target: "bun",
  format: "esm",
  external: [
    "@jitl/quickjs-wasmfile-debug-asyncify",
    "@jitl/quickjs-wasmfile-debug-sync",
    "@jitl/quickjs-wasmfile-release-asyncify",
    "@jitl/quickjs-wasmfile-release-sync",
    "node:*",
  ],
});

if (!result.success)
  throw new AggregateError(result.logs, "Could not bundle the patched QuickJS SDK.");
