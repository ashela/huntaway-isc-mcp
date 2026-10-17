# Changelog

## 0.1.1

- Every tenant and credential input box shows an example of the expected value.

## 0.1.0

First release.

- MCP server registered with VS Code's server definition provider API; runs on the editor's own Node.js.
- Tenants with credentials in VS Code secret storage, managed from the Huntaway view.
- Tools: tenants, search, identity, workflow diagnostics, workflow executions, launchers and their gate chain, form instances, accounts, hosted access requests, tenant comparison, and a raw request escape hatch.
- Read tools carry read-only annotations; writes require explicit confirmation.
- Leak gate on every package.
