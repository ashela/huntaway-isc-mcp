# Changelog

## 0.1.2

- The Huntaway view browses each tenant: sources, identity profiles, identity attributes, transforms, workflows, launchers, forms, access profiles, roles, governance groups, non-employee sources, campaign templates and SoD policies, with a count per type. Clicking an object opens its JSON read-only in an editor. Refresh re-reads the tenant.
- Add Tenant asks for the API URL first and proposes the key from the host.
- The Test Connection result stays on the tenant row instead of vanishing with a toast; failures are modal.

## 0.1.1

- Every tenant and credential input box shows an example of the expected value.

## 0.1.0

First release.

- MCP server registered with VS Code's server definition provider API; runs on the editor's own Node.js.
- Tenants with credentials in VS Code secret storage, managed from the Huntaway view.
- Tools: tenants, search, identity, workflow diagnostics, workflow executions, launchers and their gate chain, form instances, accounts, hosted access requests, tenant comparison, and a raw request escape hatch.
- Read tools carry read-only annotations; writes require explicit confirmation.
- Leak gate on every package.
