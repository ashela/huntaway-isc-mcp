# Changelog

## Unreleased

- An optional localhost endpoint for the Huntaway desktop app: **Huntaway ISC: Connect Huntaway** serves the same tools over Streamable HTTP on `127.0.0.1`, behind a token shown once and kept only as a hash, so Huntaway never holds a tenant's credentials. Off until a token exists; **Disconnect Huntaway** stops it.

## 0.2.0

- `isc_dataflow`: the tenant's data-flow diagram and attribute-level source-to-target map in Huntaway's DFD model, with transforms dereferenced and issues listed.
- `isc_nonemployee_load`: the bulk loader as a profile-driven tool. Plan, apply, resume, restore and rollback; notice workflows held off until every created identity has settled; state on disk so a dead server is recovered by restore.
- `isc_sit_cases`, `isc_workflow_evidence`, `isc_launch`: the SIT primitives. Register and verdict log, execution evidence with recipients tagged and bodies redacted, and the launcher-to-form chain with the SIT profile's guards.
- Example profiles under `resources/examples`.
- Release workflow attaches a gated pre-release `.vsix` to a GitHub Release for upload by hand; no publishing token in CI.

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
