# Documentation

## Use the gateway

- [Repository overview](../README.md): what it does, architecture, local demo, and setup.
- [Local deployment](local-installation.md): executable installation, files, HTTP
  authentication, manual client registration, updates, and lifecycle.
- [Gateway examples](../packages/gateway/examples/README.md): local stdio/HTTP and optional OAuth.

## Use the libraries

- [Codemode](../packages/codemode/README.md) and [examples](../packages/codemode/examples/README.md).
- [MCP adapters](../packages/mcp/README.md) and [examples](../packages/mcp/examples/README.md).
- [Gateway API](../packages/gateway/README.md#programmatic-api).
- [Execution/MCP reference](reference.md): exact contracts, limits, ownership, and privacy.

## Develop and verify

- [Testing conventions](testing.md) and [script guide](../scripts/README.md).
- [Installed-artifact verification](installed-validation.md).
- [QuickJS patch](../patches/README.md) and its removal gate.

## Optional diagnostics

These are not setup steps or automatic installation/CI prerequisites. Run heavy
diagnostics serially; model/provider workflows require separate explicit authorization.

- [Scripted CLI workflows](agent-validation.md): synthetic, no model/provider calls.
- [Managed-upstream transport soak](gateway-soak.md): controlled stdio/HTTP faults.
- [Bounded library reliability](reliability.md): in-memory composition, not managed Gateway hosting.
- [Actual model-agent validation](model-validation.md): paid calls requiring approval.

## History

[Archived evidence](archive/README.md) retains investigations and retired workflows.
Versions, names, measurements, and historical client configuration are not current
setup instructions. Preserving a record does not mean its commands work against today's tree.
