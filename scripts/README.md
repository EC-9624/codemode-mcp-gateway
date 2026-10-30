# Repository scripts

## Everyday use

```sh
bun run install:gw          # Build + install ~/.local/bin/gw; no setup or service startup
bun run install:gw --force  # Explicitly replace an installed file/symlink
bun run gw                 # Source CLI
bun run check              # Full source, package, and standalone checks
```

Install dependencies first with `bun install --frozen-lockfile --ignore-scripts`.
Installation changes only the executable. Run `gw setup` separately and configure
upstreams, clients, PATH, and process supervision yourself. Builds/installations
within one checkout should run serially.

## Build and artifact checks

- `build-codemode-runtime.ts` bundles the patched QuickJS SDK for package consumers.
- `build-standalone.ts` embeds the runtime, version, workers, and WASM into `dist/gw`.
- `install-gw.ts` runs that build and publishes the executable in the user's bin directory.
- `verify-packages.ts` checks fresh tarballs, public exports, declarations, and installed consumers.
- `verify-standalone.ts` checks the binary outside the checkout with an empty PATH.
- `verify-clean-packages.ts` checks a frozen clean-source install, runs `install:gw`
  in an isolated HOME, then removes its build tree before probing the installed app.

These checks protect different boundaries; they are not installation prerequisites.

## Examples

Runnable demos live in each package's `examples/`, with the shared synthetic
upstream under `examples/shared/`. Root `example`, `example:mcp`, and `example:server`
forward to the owning package. `example:http` connects to an already-running gateway;
`example:notion` remains an explicitly authorized real-account workflow. The
[example index](../examples/README.md) lists commands and expected outcomes.

## Optional diagnostics

`bun run eval:search` runs a deterministic offline search-quality comparison with
the previous ranker: graded relevance metrics, per-query results, and regression
gates. It makes no model/provider calls. See the
[search evaluation guide](../docs/search-evaluation.md) for the dataset and limits.

`bun run bench:search` measures real catalog/discovery search with synthetic
100/1,000/10,000-tool catalogs and a 1,000-tool long-description scenario. It reports
build time, warm query median/p95, approximate retained heap, and discovery page
size. It asserts basic search/pagination behavior but has no machine-specific
latency gates. It makes no upstream or model calls.

Execution/memory/concurrency/reliability baselines, gateway soak, HTTP-idle probes,
scripted agent validation, and the stdio observer remain opt-in. Their fixtures
and helpers stay with them. None runs during installation or routine `check`.
`validate:models --approve-model-calls` additionally requires explicit approval
and may incur provider charges.

[Historical studies](studies/README.md) are archived separately, with their original
measurement evidence retained. They are not current acceptance checks.
