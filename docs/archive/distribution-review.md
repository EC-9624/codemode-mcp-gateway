# Historical distribution review

Slice 36 review, 2026-10-16. **Not approved for publication.** The initial read-only
review was followed by the coordinating session's verification below. No registry
publication or release-policy change was performed. This approval statement belongs
to that historical review, not the current publication plan.

## Release boundary and decisions

- [ ] **User decision:** final names/scopes, ownership, initial versions, release
      policy, and which packages may be published. All versions are `0.0.0`;
      `@codemode-mcp-gateway/codemode` has no `private` guard, whereas MCP and gateway explicitly have
      `private: true` (`packages/codemode/package.json:2-3`,
      `packages/mcp/package.json:2-4`, `packages/gateway/package.json:2-4`). Absence of
      the guard is not publishing authorization. Do not rename or change visibility
      as a readiness cleanup.
- [ ] **User decision / distribution blocker:** license for original project code.
      None of the four manifests declares `license`; the tracked license/notice file
      inventory contains only `packages/codemode/THIRD_PARTY_NOTICES.md`, whose
      lines 3-10 identify the bundled SDK, not a license grant for this project's code.
      Recipients lack an explicit project reuse grant. Smallest remedy after owner
      approval: add the chosen project license, manifest metadata, and ensure each
      intended distributable includes that license. Do not assume the SDK's MIT license
      licenses the surrounding project.
- [ ] **Intentional private-package constraint, not a discovered runtime defect:**
      MCP/gateway registry installation is not established. Their workspace dependencies
      (`packages/mcp/package.json:28-35`, `packages/gateway/package.json:31-37`) require
      corresponding released identities/versions if registry delivery is later chosen.
      `scripts/verify-packages.ts:104-117` deliberately substitutes tarball overrides
      for unpublished packages. Keep local tarball delivery separate from registry
      readiness; do not remove overrides until the release policy changes.

## Existing contracts to preserve

- **Standalone codemode:** public executor, reports/errors/limits, tool validation,
  catalog, and discovery exports (`packages/codemode/src/index.ts:1-30`), without
  MCP. Its manifest dependencies contain no MCP/workspace package
  (`packages/codemode/package.json:28-35`).
- **Root-only ESM API:** all three export maps expose only `.`; installed JS and
  declarations come from `dist/`. The `development` condition points to unshipped
  `src/`, and is only for repository runs. Do not enable it in installed consumers.
  CommonJS/Node support is not promised. Bun 1.4.3 is pinned by `.bun-version:1`
  and manifest engines. Build tsconfigs clear source conditions, emit declarations,
  and inherit `.ts` import rewriting (`tsconfig.json:3-7` and each package's
  `tsconfig.build.json:3-10`).
- **Execution semantics:** fresh workers, explicit expected result failures,
  host-only infrastructure diagnostics, metadata-only call observations,
  cooperative tool cancellation, fixed policy/admission, and no rollback or OS
  isolation guarantee (`packages/codemode/README.md:23-46,52-177`). Defaults are
  observable API: standalone deadlines are unset, unlike gateway defaults.
- **MCP adapter:** borrows connected clients/executors; it does not select a VM or
  own application connections. `execute({ code })` yields display `content`, not
  host reports (`packages/mcp/README.md:43-69,101-119`).
- **Gateway:** public composition/auth/config API and separate `gw` executable;
  importing the root must not start serving or register signal handlers
  (`packages/gateway/src/index.ts:1-13`,
  `packages/gateway/tests/fixtures/import-gateway.ts:1-19`). Private visibility
  does not make local consumers immune to migration breakage.

Before the first release, consolidate the already documented migrations:
completed calls no longer retain `result`; discovery returns a paged object rather
than an array; `createCodemodeServer` accepts `execute` rather than
`catalog`/`sandbox`; clients read `content` rather than
`structuredContent.result.value`; `CodemodeResponse`/`CallSummary` were removed
(`packages/codemode/README.md:100-102,186-193`,
`packages/mcp/README.md:116-119`). Preserve exact qualified gateway tool names and
configuration/credential identity rules when changing names or defaults
(`packages/gateway/README.md:72-96,327-333`).

## SDK patch and notices

- [x] **Implementation present:** core 0.32.0 is patched in the root manifest and
      lockfile (`package.json` patchedDependencies, `bun.lock:70-72`). The codemode build bundles the
      SDK JS specifically because consumers do not inherit workspace patches;
      four WASM variants remain external (`scripts/build-codemode-runtime.ts:3-21`).
      Codemode's `prepack` calls that build (`packages/codemode/package.json:21-26`).
- [x] **Bundled notice present:** `THIRD_PARTY_NOTICES.md:3-28` identifies SDK/core
      and FFI constants and includes MIT text matching the inspected installed SDK/core
      licenses. It is allowlisted and asserted in the package verifier
      (`packages/codemode/package.json:5-8`, `scripts/verify-packages.ts:25-27`).
- [ ] **Pending artifact/license inventory:** confirm actual bundle inputs still
      match the notice and external WASM packages retain their own notices. Existing
      checks assert notice presence, not complete license contents or bundle provenance.
      No missing third-party notice was proven in this review.
- [ ] **Maintenance/removal gate:** review upstream #240/#248 and an actual fixed
      release before upgrading; this review did not check current upstream status.
      `patches/README.md:3-13,32-39` records the stale WASM view/disposal failure and
      removal intent. Update SDK/core/variant pins and lockfile together, then rerun
      source and standalone packed large-result regressions. Remove the patch and
      workaround bundling only after proving the replacement delivers the fix without
      consumer patches; retain any notices still required by remaining bundled code.

## Verification gaps and smallest next actions

- [x] **Local packaging path established; implicit hook dependency explained:** root checks
      build in dependency order, then pack with `--ignore-scripts`
      (`package.json`, `scripts/verify-packages.ts:13-22`). They do not prove
      lifecycle-enabled prepack from a clean source checkout. Build tooling, root
      tsconfig, patch, and bundler script live in the monorepo; building a package
      directory copied alone is not an established source-distribution contract.
      In the clean-source check below, ordinary `bun pm pack` did not execute `prepack`
      in this environment and omitted `dist/`; removing `--quiet` did not change that.
      The codemode archive contained only its manifest, README, and notices. This is a
      proven local failure of relying on the hook, not a claim about all Bun setups.
      Slice 38 found the user's global `~/.npmrc` sets `ignore-scripts=true`.
      That explains the skipped hook; it is not an unexplained Bun packaging defect.
      The safeguard was not changed or bypassed. **Use an explicit root `bun run build`
      before packing**, as the supported verifier already does. The new
      `bun run verify:packages:clean` automates a current-source copy, frozen install
      with scripts disabled, explicit build, tarball inspection, and installed
      consumers without touching shared build/install directories or creating a
      Git worktree. This command passed on Bun 1.4.3. No automatic-hook guarantee is made.
- [x] **Fresh installed validation passed after explicit build:** the existing verifier checks exact
      emitted JS/declaration inventory, worker asset, README/notice, absence of
      source/tests/node_modules, and workspace dependency rewriting
      (`scripts/verify-packages.ts:13-58`). It then installs codemode alone without
      scripts, typechecks declarations with `skipLibCheck: false`, and executes real
      workers/cancellation (`:61-94`; standalone fixture `:5-37,39-83`). Composition
      checks cover installed roots, adapter, import listener lifetime, and CLI/config
      directory behavior (`:96-159`). The coordinating session ran these scenarios
      against the artifacts described below. They do not establish registry availability
      or byte-identical builds.
- [ ] **Proven documentation packaging gap (non-runtime):** the codemode README
      links to omitted source and repository-level docs/examples/patches
      (`packages/codemode/README.md:49-50,181,196-199,228-230`), while the allowlist ships
      only `dist`, README, and notices. Those links are unavailable inside an installed
      package. Smallest remedy after repository/release identity is decided: stable
      repository URLs or self-contained package instructions; not shipping internals
      merely to satisfy links.

## Coordinated verification: 2026-10-16

Source: `149cf22` plus the uncommitted slice changes, Bun 1.4.3, macOS arm64.

- `bun run check` passed: build, typecheck, lint, formatting, **656 tests**, and
  isolated installed-consumer checks.
- `bun run example` passed its expected success/failure/cancellation scenarios.
- A disposable full source copy contained no inherited `node_modules`, `dist`, or
  Git worktree. `bun install --frozen-lockfile --ignore-scripts` passed.
- Ordinary package-local `bun pm pack --filename <archive>` before any explicit
  build produced archives without runtime assets. Codemode failed the verifier
  with `Missing built asset package/dist/runtime/worker.js`.
- An explicit root `bun run build`, then package-local packing in dependency order,
  produced complete archives. The existing verifier's inventory and installed
  consumer scenarios all passed against these three archives. Only its initial
  archive-creation step was changed in the disposable copy to copy the candidate
  archives rather than repack them; no assertions or consumer fixtures changed.

The temporary source copy is not a new worktree. These checks do not resolve the
license/naming decisions or establish that automatic prepack hooks work. Slice 38
automated this local verification and explained the skipped hook as the global
script-disable setting. Release decisions remain deferred: the user wants local
use only, not a release.

## Reproduction

Run serially using Bun 1.4.3:

```sh
bun run check
bun run example
bun run verify:packages:clean
```

`check` includes built-artifact isolated-consumer verification. For a focused rerun:
`bun run verify:packages`. The separate `verify:packages:clean` starts without
inherited `node_modules`/`dist`, installs with a frozen lockfile and scripts off,
then explicitly builds before packing with scripts off. Both use the same archive
inventory and installed-consumer scenarios, without development export conditions
or consumer patches. The clean command copies tracked and untracked nonignored
source, so it checks current edits rather than just HEAD. Deleted files stay deleted.
Temporary sources, installs, and archives are removed on every exit path.

For retained local tarballs, use the explicit build/pack commands in
[installed validation](../installed-validation.md#prepare-an-external-consumer).
Never infer a prepack hook ran just because packing exited zero; honor the user's
script-disable policy. Nothing here publishes or authorizes a release.
