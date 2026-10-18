# Distribution checklist

Public source, downloadable executables, and registry packages are separate
deliverables. Documentation cleanup does not publish or approve any artifact.

## Public source repository

- [x] License original project code under MIT, with license files and metadata in
      the repository and workspace packages. Third-party notices remain separate.
- [ ] Choose the GitHub owner/repository URL before adding permanent external links.
- [ ] Scan the working tree **and Git history** for credentials/private data. Moving
      or redacting a file in HEAD does not remove earlier copies; investigate findings,
      rotate exposed credentials, and obtain approval before rewriting history.
- [ ] Run documented local examples, link checks, `bun run check`, and
      `bun run verify:packages:clean` from the final source tree.
- Preserve historical measurements as dated evidence rather than rewriting them
  as current performance or production-readiness claims.

## Standalone binary releases

- [ ] Choose initial versions and supported OS/architecture targets. Current builds
      target the host; standalone verification establishes macOS arm64 only.
- [ ] Audit all embedded dependencies/runtime/WASM license obligations; the package's
      bundled-SDK notice alone is not a complete executable provenance/license inventory.
- [ ] Decide release hosting, checksums/signing, installation, and update instructions.
      No public downloads, curl installer, automatic updater, or release automation exists.
- [ ] Verify the actual release binaries, not just source exports.

## Registry packages

- [ ] Decide whether to publish libraries/product packages at all, and settle names,
      scopes, ownership, versions, dependency versions, and supported consumers.
- MCP/gateway remain `private: true`; absence of a private flag on codemode does not
  authorize publication. Keep guards unchanged until that decision.
- Local tarball overrides verify installed artifacts, not registry resolution.
- Package READMEs ship; source/examples/tests remain checkout-only.
- Keep the patched QuickJS build until a reviewed replacement proves the memory-view
  fix without consumer patches; retain all required third-party notices.

The [earlier distribution review](archive/distribution-review.md) preserves original
findings and finite checks. The [artifact guide](installed-validation.md) describes
current verification; neither is permission to publish, push, or rewrite history.
