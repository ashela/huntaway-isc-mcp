# Huntaway: SailPoint ISC MCP

An MCP server for SailPoint Identity Security Cloud that lives inside VS Code. Once a tenant is added, Copilot Chat (and any other MCP client the editor hosts) can search identities, read workflows with their diagnostics, replay what a workflow actually did, trace a launcher to the people who can see it, inspect form instances, list accounts on a source, use SailPoint's hosted access-request tools, and compare two tenants for drift.

Nothing to install beside the extension. The server runs on the editor's own Node.js.

## Setup

1. Open the **Huntaway** view in the activity bar and choose **Add Tenant**.
2. Give it a short key (`dev`, `prod`, `sandbox`), a label, and its API host, `https://<tenant>.api.identitynow.com`.
3. Enter a client id and secret. Prefer a **Personal Access Token**: an API client has no user context, so workflows, forms, launchers and work-items return 403 through it whatever its scopes.
4. In chat, ask for something: "list the workflows on dev", "who can see the Onboard Contractor launcher", "compare transforms between dev and prod".

Credentials go to VS Code's secret storage (the operating system keychain) and reach the server only as an environment variable of its own process, at start. They are never written to `settings.json`, so Settings Sync and a committed `.vscode` folder cannot carry them.

**Test Connection** on a tenant proves the credential and tells you whether it has user context; the result stays on the tenant's row.

## Browsing a tenant

Each tenant in the Huntaway view opens into its object types: sources, identity profiles, identity attributes, transforms, workflows, launchers, forms, access profiles, roles, governance groups, non-employee sources, campaign templates and SoD policies, with a count per type. Click an object to open its JSON read-only in an editor. The listing is read once per session; Refresh re-reads it. Nothing here writes to the tenant.

## Tools

| Tool | What it does | Writes? |
|---|---|---|
| `isc_tenants` | Lists tenants and measures each credential's reach by probing the four user-context endpoints. | No |
| `isc_search` | Search queries against the search index. | No |
| `isc_identity` | Reads identities directly, so values are current, with an optional sweep for unresolved templates. | No |
| `isc_workflow` | Lists workflows, or reads one with step count against the licence cap, OAuth bind state per http step, and unreachable steps. | No |
| `isc_workflow_executions` | Recent executions and, on request, every step's real input, output and error. | No |
| `isc_launchers` | Launchers, and for one launcher the whole gate chain: workflow, forms, entitlement, access profile, role and member count. | No |
| `isc_form_instances` | Form instances with their `formErrors`, filtered by state client-side. | No |
| `isc_accounts` | Accounts on a source, with an optional sweep for unresolved templates. | No |
| `isc_compare_tenants` | Logic drift between two tenants for one object type, with ids, timestamps, owners, email addresses and each tenant's environment tokens masked. | No |
| `isc_access_requests` | SailPoint's hosted access-request tools, through the tenant's own endpoint. | create and cancel |
| `isc_dataflow` | The tenant's data-flow diagram and attribute-level source-to-target map, in Huntaway's DFD model: sources, identity profiles with transforms dereferenced, CREATE policies, attribute sync, correlation, and the issues found on the way. | No |
| `isc_nonemployee_load` | Bulk-create non-employee records from a tab-separated export with the notice workflows held off until every identity has settled. `plan` is a dry run; `apply`, `restore` and `rollback` need confirmation. | apply, restore, rollback |
| `isc_request` | Any method, any path. The escape hatch. | Any method but GET |

Read tools are marked read-only. The two that can write require `confirm: true`, which the assistant may set only after you have agreed to that specific change, and the editor asks before running them.

### Diagnostics worth knowing

- **The step cap is enforced on enable, not on save.** A workflow already above it was grandfathered in while enabled and cannot be re-enabled once disabled. `isc_workflow` says so before you touch it. Set your licence's cap in **Settings: Huntaway ISC: Workflow Step Cap** (20, 50 or 100).
- **An http step's OAuth binding is builder-only.** Writing `param_oauth`/`refID` through the API leaves an unbound shell that fails at runtime. `isc_workflow` reports `bound: false` per step.
- **Launcher visibility is an entitlement, not an admin level.** The gate entitlement matches on the launcher's id as its value, never its name. `isc_launchers` walks the chain and reports the two usual causes: no gate entitlement, or a gate role matching zero identities.
- **A 200 on a form submit does not mean it was submitted.** A validation failure leaves the instance `IN_PROGRESS`; `isc_form_instances` shows the `formErrors`.
- **The search index lags.** When the answer drives a decision, confirm with `isc_identity`.

### Bulk loading non-employee records

`isc_nonemployee_load` is the contractor loader generalised. Nothing about a tenant is in the extension: a **load profile** JSON you keep beside the data names the non-employee source, how a login, uid and address are formed, which file columns feed which record fields, which reference sources hold the codes, the form whose option lists validate values, the notice workflows to hold off, the lifecycle timing and the quiet windows. `resources/examples/nonemployee-profile.example.json` is a complete starting point.

The sequence is `plan` (a dry run: every line comes back LOAD or SKIP with the reason, plus a PLAN DIGEST), then `apply` with `confirm: true` and that digest. The apply runs as a job inside the server: it snapshots the identities it watches, disables the notice workflows (the STATE file on disk names them before the first write), creates one record at a time with a write-ahead entry in the RESULTS file, waits for every created identity to settle, and only then re-enables the workflows. If anything is not right they stay off and the reply names the `restore` to run. `rollback` deletes what a results file created, the same way. Work files live under `~/.huntaway-isc/<tenant>` (override with `HUNTAWAY_ISC_WORK_DIR`).

A POST whose answer was lost is never re-sent: the record is found by login. A record counts as gone only on two 404 reads. A workflow whose definition changed while it was off is never re-enabled by the tool.

### Comparing tenants

Objects pair by name. Each tenant can carry **environment tokens** (set on the tenant, for example `DEV, dev-tenant` on one side and `UAT, uat-tenant` on the other). They are masked to `<ENV>` before the diff, as are ids, timestamps, owners, health, run counters and email addresses. `enabled` is deliberately not masked. Recipient fields are counted separately, because a build tenant routes mail to a test address on purpose.

## Requirements

VS Code 1.101 or later. Nothing else.

## Privacy

The extension talks only to the tenant hosts you configure. Responses are returned to the chat you are in and are not stored by the extension. Every result names the tenant that answered.

## Development

```
npm ci
npm test          # builds, then unit tests and a stdio round trip against a fake API
npm run package   # builds, gates, packages, unzips the .vsix and gates its contents
```

The leak gate (`scripts/leak-gate.mjs`) fails packaging on email addresses, object ids, tenant hosts, credential-looking values and a private term list that is never committed. Put yours in `.leak-gate.local` (gitignored) and in the `LEAK_GATE_TERMS` repository secret.

### Publishing

No token publishes from CI: global Marketplace PATs retire on 1 December 2026. A `v<version>` tag runs the Release workflow, which builds and gates the `.vsix` (as a pre-release for every 0.x version) and attaches it to a GitHub Release. Then:

1. Download the `.vsix` and install it locally once: `code --install-extension <file> --force`.
2. Upload it at https://marketplace.visualstudio.com/manage/publishers/huntaway.

The same by hand: `npm run package -- --pre-release`. When publishing should be automatic, the route is Azure Pipelines with a managed identity and `vsce publish --azure-credential`.

## Licence

MIT. SailPoint and Identity Security Cloud are trademarks of SailPoint Technologies. This extension is not affiliated with SailPoint.
