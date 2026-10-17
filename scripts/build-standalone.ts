import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const root = fileURLToPath(new URL("../", import.meta.url));

const manifest = z
  .object({ version: z.string() })
  .parse(await Bun.file(join(root, "packages/gateway/package.json")).json());

const result = await Bun.build({
  entrypoints: [
    join(root, "packages/gateway/dist/cli.js"),
    join(root, "packages/codemode/dist/runtime/worker.js"),
  ],
  naming: "[name].[ext]",
  target: "bun",
  format: "esm",
  compile: {
    outfile: join(root, "dist/gw"),
    // A downloaded app must not inherit arbitrary runtime settings from its cwd.
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
  define: { GW_BUILD_VERSION: JSON.stringify(manifest.version) },
  plugins: [
    {
      name: "embedded-quickjs-wasm",
      setup(build) {
        build.onResolve(
          { filter: /^@jitl\/quickjs-wasmfile-[^/]+\/emscripten-module$/ },
          (args) => ({
            // The wrapper needs a distinct identity from the real loader it imports.
            path: Bun.resolveSync(args.path, dirname(args.importer)) + ".embedded",
            namespace: "embedded-quickjs-wasm",
          }),
        );
        build.onResolve({ filter: /.*/, namespace: "embedded-quickjs-wasm" }, (args) =>
          args.path.startsWith("node:")
            ? { path: args.path, external: true }
            : { path: args.path, namespace: "file" },
        );
        build.onLoad({ filter: /.*/, namespace: "embedded-quickjs-wasm" }, (args) => {
          const path = args.path.slice(0, -".embedded".length);

          return {
            // Emscripten's dynamic sibling-WASM lookup cannot locate embedded assets.
            // Supply its documented wasmBinary option without rewriting SDK source.
            contents: `import load from ${JSON.stringify(path)};
import wasm from ${JSON.stringify(join(dirname(path), "emscripten-module.wasm"))} with { type: "file" };
import { readFileSync } from "node:fs";
export default (options) => load({ ...options, wasmBinary: readFileSync(wasm) });`,
            loader: "js",
          };
        });
      },
    },
  ],
});

if (!result.success) throw new AggregateError(result.logs, "Could not build standalone gw.");

console.log(`Built standalone gw: ${join(root, "dist/gw")}`);
