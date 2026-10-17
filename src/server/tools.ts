// The tools. Read tools carry readOnlyHint; the two that can write
// (isc_request with a non-GET method, isc_access_requests create/cancel)
// carry destructiveHint and refuse to run without `confirm: true`, so the
// editor asks the person and the model has to state intent.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IscClient, IscError, describe } from "./isc.js";
import {
  COLLECTORS, COMPARE_ALIASES, COMPARE_TYPES, diffObjects, makeNormaliser, nameOf, recipients, short, topKey,
  type ReadOnlyView,
} from "./compare.js";
import { analyseWorkflow, formSteps, stepsOf, httpSteps } from "./diagnostics.js";
import { buildDataFlow, dataFlowBlock, gather, summarise as summariseDataFlow } from "./dataflow.js";
import { registerNonEmployeeTool } from "./nonemployee/tool.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { MAX_CHARS_DEFAULT, asList, asRecord, clip, isOk, leakedAttributes, lower, matchByName, q, rows, type Json } from "./util.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function reply(value: Json): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 1) }] };
}

/** An IscError becomes a plain result the model can act on; anything else is a bug. */
async function guarded(fn: () => Promise<Json>): Promise<ToolResult> {
  try {
    return reply(await fn());
  } catch (error) {
    if (error instanceof IscError) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: error.message }) }], isError: true };
    throw error;
  }
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

const tenantArg = z.string().optional().describe("Tenant key, as listed by isc_tenants. Omit for the default tenant.");
const maxChars = z.number().int().positive().optional().describe(`Clip the response at this many characters (default ${MAX_CHARS_DEFAULT}).`);

export interface ToolOptions {
  stepCap: number;
  /** Hours the operator's calendar day runs ahead of UTC (HUNTAWAY_ISC_TODAY_OFFSET_HOURS). */
  todayOffsetHours?: number;
}

export function registerTools(server: McpServer, isc: IscClient, options: ToolOptions): void {
  const { stepCap } = options;

  server.registerTool(
    "isc_tenants",
    {
      title: "List tenants",
      description:
        "List the configured ISC tenants, their host, and whether auth currently succeeds. With probe=true " +
        "(the default) it also MEASURES whether the credential has user context by calling four endpoints " +
        "that return 403 without it: workflows, launchers, forms and work-items. Start here when something " +
        "returns 403 or when you are unsure a tenant is wired up. Never returns secret values.",
      inputSchema: { probe: z.boolean().optional().describe("Probe the four user-context endpoints (default true).") },
      annotations: READ,
    },
    async ({ probe }) => guarded(async () => {
      const USER_CONTEXT: Record<string, string> = {
        workflows: "/beta/workflows",
        launchers: "/v2025/launchers?limit=1",
        forms: "/v2025/form-definitions?limit=1",
        "work-items": "/beta/work-items?limit=1",
      };
      const out: Record<string, Json>[] = [];
      for (const tenant of isc.tenants) {
        const row: Record<string, Json> = { tenant: tenant.key, label: tenant.label, host: new URL(tenant.baseUrl).host, is_default: Boolean(tenant.isDefault) };
        if (tenant.purpose) row.purpose = tenant.purpose;
        try {
          await isc.token(tenant.key);
          row.auth = "ok";
          if (probe !== false) {
            const reach: Record<string, number> = {};
            for (const [label, path] of Object.entries(USER_CONTEXT)) reach[label] = (await isc.call(tenant.key, "GET", path, undefined, "application/json", 1)).status;
            const denied = Object.entries(reach).filter(([, s]) => s === 401 || s === 403).map(([k]) => k);
            const allowed = Object.entries(reach).filter(([, s]) => isOk(s)).map(([k]) => k);
            row.user_context_reach = reach;
            row.has_full_user_context = denied.length === 0;
            if (denied.length) {
              row.warning =
                `Denied on ${denied.join(", ")} (reachable: ${allowed.join(", ") || "none"}). Those endpoints need user context, ` +
                "which an ISC API client does not have regardless of scope. Configure a Personal Access Token for this tenant if you need them.";
            }
          }
        } catch (error) {
          row.auth = "unavailable";
          row.detail = describe(error);
        }
        out.push(row);
      }
      const def = isc.tenants.find((t) => t.isDefault);
      return { tenants: out, default_tenant: def?.key ?? (isc.tenants.length === 1 ? isc.tenants[0].key : null), configured_in: "VS Code: Huntaway ISC view" };
    }),
  );

  server.registerTool(
    "isc_request",
    {
      title: "Raw ISC API request",
      description:
        "Make any ISC API call: any method, any path, any body. The escape hatch for anything the specific tools " +
        "do not cover. Paths are version-prefixed, e.g. /v2025/identities, /beta/workflows, /v2025/search. " +
        "Pass json_patch=true to send a JSON-Patch body (required by workflow PATCH).\n\n" +
        "Any method other than GET WRITES to the tenant and requires confirm=true, after the user has agreed. " +
        "Known destructive operations: aggregating an authoritative delimited-file source with an incomplete file " +
        "(it terminates every identity missing from the file); writing param_oauth/refID on a workflow http step " +
        "(OAuth binding is builder-only; an API write leaves an unbound shell); a full PUT of a source (writes masked " +
        "passwords back as asterisks). A workflow already above the step cap CANNOT be re-enabled once disabled: " +
        "read isc_workflow before any disable/patch/enable cycle.",
      inputSchema: {
        path: z.string().describe("Version-prefixed path, e.g. /v2025/identities?limit=5"),
        method: z.string().optional().describe("HTTP method (default GET)."),
        body: z.unknown().optional().describe("JSON body for POST/PUT/PATCH."),
        json_patch: z.boolean().optional().describe("Send the body as application/json-patch+json."),
        confirm: z.boolean().optional().describe("Required true for any method other than GET: the user has agreed to this write."),
        tenant: tenantArg,
        max_chars: maxChars,
      },
      annotations: WRITE,
    },
    async ({ path, method = "GET", body, json_patch, confirm, tenant, max_chars = MAX_CHARS_DEFAULT }) => guarded(async () => {
      const verb = method.toUpperCase();
      if (verb !== "GET" && confirm !== true) {
        return isc.envelope(tenant, {
          ok: false,
          refused: `${verb} ${path} writes to the tenant. Ask the user, then call again with confirm=true.`,
        });
      }
      const { status, body: data } = await isc.call(tenant, verb, path, body, json_patch ? "application/json-patch+json" : "application/json");
      return isc.envelope(tenant, { method: verb, path, status, ok: isOk(status), body: clip(data, max_chars) });
    }),
  );

  server.registerTool(
    "isc_search",
    {
      title: "Search",
      description:
        "Run an ISC search query (POST /v2025/search). The workhorse for finding identities by attribute, e.g. " +
        "'identityProfile.name:\"Employees\" AND attributes.cloudLifecycleState:\"active\"'.\n\n" +
        "Returns the SEARCH INDEX, which lags live data by seconds to minutes. When correctness matters " +
        "(lifecycle state after a change, an attribute you just wrote) confirm with isc_identity, which reads the identity directly.",
      inputSchema: {
        query: z.string().describe("Search query string."),
        indices: z.array(z.string()).optional().describe('Indices to search (default ["identities"]).'),
        limit: z.number().int().positive().optional().describe("Max results (default 50)."),
        fields: z.array(z.string()).optional().describe("Return only these top-level or attribute fields per row."),
        tenant: tenantArg,
        max_chars: maxChars,
      },
      annotations: READ,
    },
    async ({ query, indices, limit = 50, fields, tenant, max_chars = MAX_CHARS_DEFAULT }) => guarded(async () => {
      const payload = { indices: indices?.length ? indices : ["identities"], query: { query } };
      const { status, body } = await isc.call(tenant, "POST", q("/v2025/search", { limit }), payload);
      if (!isOk(status) || !Array.isArray(body)) return isc.envelope(tenant, { status, ok: false, query, body: clip(body, max_chars) });
      let out: Json = body;
      if (fields?.length) {
        out = asList(body).map((r) => {
          const attrs = asRecord(r.attributes);
          const slim: Record<string, unknown> = {};
          for (const f of fields) slim[f] = f in r ? r[f] : attrs[f];
          return slim;
        });
      }
      return isc.envelope(tenant, { status, ok: true, query, count: body.length, results: clip(out, max_chars) });
    }),
  );

  server.registerTool(
    "isc_identity",
    {
      title: "Read identity",
      description:
        "Read identities DIRECTLY (not via the search index), so the values returned are current. Look up by name, " +
        "alias/uid, or id. Use this over isc_search whenever the answer drives a decision: lifecycle state, manager, an " +
        "attribute just written. Set leaks=true to flag attributes still holding an unresolved '{{ }}' template or a raw '$.' JSONPath.",
      inputSchema: {
        name: z.string().optional().describe("Identity name or alias."),
        identity_id: z.string().optional().describe("Identity id."),
        attributes: z.array(z.string()).optional().describe("Return only these attributes."),
        leaks: z.boolean().optional().describe("Flag unresolved template or JSONPath values."),
        limit: z.number().int().positive().optional().describe("Max identities when a name matches several (default 10)."),
        tenant: tenantArg,
        max_chars: maxChars,
      },
      annotations: READ,
    },
    async ({ name, identity_id, attributes, leaks, limit = 10, tenant, max_chars = MAX_CHARS_DEFAULT }) => guarded(async () => {
      if (!name && !identity_id) return isc.envelope(tenant, { ok: false, error: "pass name or identity_id" });
      let ids: string[] = identity_id ? [identity_id] : [];
      if (!ids.length && name) {
        for (const filter of [`name eq "${name}"`, `alias eq "${name}"`]) {
          const { status, body } = await isc.call(tenant, "GET", q("/v2025/identities", { filters: filter, limit }));
          if (isOk(status) && Array.isArray(body) && body.length) {
            ids = asList(body).map((i) => String(i.id));
            break;
          }
        }
      }
      if (!ids.length) return isc.envelope(tenant, { ok: false, error: `no identity matched ${JSON.stringify(name)}` });
      const out: Record<string, Json>[] = [];
      for (const iid of ids.slice(0, limit)) {
        const { status, body } = await isc.call(tenant, "GET", `/beta/identities/${iid}`);
        if (!isOk(status) || !body || typeof body !== "object") {
          out.push({ id: iid, status, error: body });
          continue;
        }
        const full = asRecord(body);
        const attrs = asRecord(full.attributes);
        const picked: Record<string, unknown> = {};
        if (attributes?.length) for (const k of attributes) if (k in attrs) picked[k] = attrs[k];
        const row: Record<string, Json> = {
          id: iid,
          name: full.name,
          alias: full.alias,
          lifecycleState: attrs.cloudLifecycleState ?? null,
          attributes: attributes?.length ? picked : attrs,
        };
        if (leaks) row.leaked_attributes = leakedAttributes(attrs);
        out.push(row);
      }
      return isc.envelope(tenant, { ok: true, count: out.length, identities: clip(out, max_chars) });
    }),
  );

  async function readWorkflow(tenant: string | undefined, name?: string, workflowId?: string) {
    const { status, body } = await isc.call(tenant, "GET", "/beta/workflows");
    if (!isOk(status) || !Array.isArray(body)) return { error: await isc.envelope(tenant, { ok: false, status, body: clip(body, MAX_CHARS_DEFAULT) }) };
    const listing = asList(body);
    if (!name && !workflowId) return { listing };
    let wid = workflowId;
    if (!wid && name) {
      const found = matchByName(listing, name, "workflow");
      if (!found.match) return { error: await isc.envelope(tenant, { ok: false, error: found.error, candidates: found.candidates }) };
      wid = String(found.match.id);
    }
    const one = await isc.call(tenant, "GET", `/beta/workflows/${wid}`);
    if (!isOk(one.status) || !one.body || typeof one.body !== "object") return { error: await isc.envelope(tenant, { ok: false, status: one.status, body: clip(one.body, MAX_CHARS_DEFAULT) }) };
    return { listing, workflow: asRecord(one.body), id: wid! };
  }

  server.registerTool(
    "isc_workflow",
    {
      title: "Workflow diagnostics",
      description:
        `List workflows, or read one with the diagnostics that are easy to get wrong by hand: step count against the ${stepCap}-step ` +
        "licence cap, per-http-step OAuth bind state, and any step unreachable from the trigger.\n\nRead this BEFORE any " +
        "disable/patch/enable cycle. The cap is enforced on ENABLE, not on save, so a workflow already above it was grandfathered " +
        "in while enabled and CANNOT be re-enabled once disabled: a one-line edit permanently retires it. An http step showing " +
        "bound=false will fail at runtime; OAuth must be bound by hand in the builder.",
      inputSchema: {
        name: z.string().optional().describe("Workflow name (exact, then substring)."),
        workflow_id: z.string().optional().describe("Workflow id."),
        include_definition: z.boolean().optional().describe("Include the full definition (clipped)."),
        tenant: tenantArg,
        max_chars: maxChars,
      },
      annotations: READ,
    },
    async ({ name, workflow_id, include_definition, tenant, max_chars = MAX_CHARS_DEFAULT }) => guarded(async () => {
      const read = await readWorkflow(tenant, name, workflow_id);
      if (read.error) return read.error;
      if (!read.workflow) {
        const list = read.listing!
          .map((w) => ({ id: w.id, name: w.name, enabled: w.enabled, modified: w.modified }))
          .sort((a, b) => lower(a.name).localeCompare(lower(b.name)));
        return isc.envelope(tenant, { ok: true, count: list.length, workflows: clip(list, max_chars) });
      }
      const result: Record<string, Json> = { ...analyseWorkflow(read.workflow, stepCap), id: read.id };
      // Clip only the definition. Clipping the whole result would replace the
      // diagnostics, the reason to call this tool, with a truncation envelope.
      if (include_definition) result.definition = clip(read.workflow.definition ?? {}, max_chars);
      return isc.envelope(tenant, { ok: true, workflow: result });
    }),
  );

  server.registerTool(
    "isc_workflow_executions",
    {
      title: "Workflow executions",
      description:
        "Read what a workflow ACTUALLY did. Lists recent executions and, with include_history, returns every step's real " +
        "input, output and error, including a rendered email body. This is the only reliable way to see what a transform " +
        "emitted, why a step failed, or what a notification said: config shows intent, history shows behaviour. " +
        "Filter with status='Failed' to go straight to the breakages.",
      inputSchema: {
        workflow_id: z.string().optional(),
        name: z.string().optional().describe("Workflow name, when workflow_id is unknown."),
        execution_id: z.string().optional().describe("One execution's full history."),
        status: z.string().optional().describe("Keep only executions with this status, e.g. Failed."),
        include_history: z.boolean().optional().describe("Fetch each execution's step history."),
        limit: z.number().int().positive().optional().describe("Max executions (default 10)."),
        tenant: tenantArg,
        max_chars: maxChars,
      },
      annotations: READ,
    },
    async ({ workflow_id, name, execution_id, status, include_history, limit = 10, tenant, max_chars = MAX_CHARS_DEFAULT }) => guarded(async () => {
      if (execution_id) {
        const { status: st, body } = await isc.call(tenant, "GET", `/beta/workflow-executions/${execution_id}/history`);
        return isc.envelope(tenant, { ok: isOk(st), execution_id, history: clip(body, max_chars) });
      }
      let wid = workflow_id;
      if (!wid && name) {
        const read = await readWorkflow(tenant, name);
        if (read.error) return read.error;
        wid = read.id;
      }
      if (!wid) return isc.envelope(tenant, { ok: false, error: "pass workflow_id, name, or execution_id" });
      const { status: st, body } = await isc.call(tenant, "GET", q(`/beta/workflows/${wid}/executions`, { limit }));
      if (!isOk(st) || !Array.isArray(body)) return isc.envelope(tenant, { ok: false, status: st, body: clip(body, max_chars) });
      let execs = asList(body);
      if (status) execs = execs.filter((e) => lower(e.status) === status.toLowerCase());
      const out: Record<string, Json>[] = [];
      for (const e of execs.slice(0, limit)) {
        const row: Record<string, Json> = { id: e.id, status: e.status, start: e.startTime, end: e.endTime };
        if (include_history) {
          const hist = await isc.call(tenant, "GET", `/beta/workflow-executions/${e.id}/history`);
          const trace: Record<string, Json>[] = [];
          for (const ev of asList(hist.body)) {
            const at = asRecord(ev.attributes);
            const type = String(ev.type ?? "");
            if (type === "ActivityTaskCompleted" || type === "ActivityTaskFailed") {
              trace.push({ step: at.displayName, type, result: at.result, error: at.error ?? at.reason });
            } else if (type.includes("Fail")) {
              trace.push({ type, detail: at });
            }
          }
          row.steps = trace;
        }
        out.push(row);
      }
      return isc.envelope(tenant, { ok: true, workflow_id: wid, count: out.length, executions: clip(out, max_chars) });
    }),
  );

  async function resolveSource(tenant: string | undefined, sourceName?: string, sourceId?: string) {
    if (sourceId) return { id: sourceId };
    if (!sourceName) return { error: await isc.envelope(tenant, { ok: false, error: "pass source_name or source_id" }) };
    const { status, body } = await isc.call(tenant, "GET", q("/v2025/sources", { limit: 250 }));
    if (!Array.isArray(body)) return { error: await isc.envelope(tenant, { ok: false, status, body: clip(body, MAX_CHARS_DEFAULT) }) };
    const list = asList(body);
    const match = list.find((s) => lower(s.name) === sourceName.toLowerCase());
    if (!match) return { error: await isc.envelope(tenant, { ok: false, error: `no source named ${JSON.stringify(sourceName)}`, available: list.map((s) => s.name) }) };
    return { id: String(match.id) };
  }

  server.registerTool(
    "isc_accounts",
    {
      title: "Accounts on a source",
      description:
        "List accounts on a source, optionally filtered by account name, with an optional sweep for attributes still " +
        "holding an unresolved '{{ }}' template or raw '$.' JSONPath. The account, not the source record, is what " +
        "identity attributes and lifecycle states are computed from, so this is where to look when an identity " +
        "disagrees with its record. Pass source_name or source_id.",
      inputSchema: {
        source_name: z.string().optional(),
        source_id: z.string().optional(),
        account_name: z.string().optional().describe("Exact account name filter."),
        leaks: z.boolean().optional().describe("Report accounts with unresolved template or JSONPath values."),
        limit: z.number().int().positive().optional().describe("Max accounts (default 250)."),
        tenant: tenantArg,
        max_chars: maxChars,
      },
      annotations: READ,
    },
    async ({ source_name, source_id, account_name, leaks, limit = 250, tenant, max_chars = MAX_CHARS_DEFAULT }) => guarded(async () => {
      const src = await resolveSource(tenant, source_name, source_id);
      if (src.error) return src.error;
      let filter = `sourceId eq "${src.id}"`;
      if (account_name) filter += ` and name eq "${account_name}"`;
      const { status, body } = await isc.call(tenant, "GET", q("/v2025/accounts", { filters: filter, limit }));
      if (!isOk(status) || !Array.isArray(body)) return isc.envelope(tenant, { ok: false, status, body: clip(body, max_chars) });
      const accounts = asList(body).map((a) => ({ id: a.id, name: a.name, identityId: a.identityId, modified: a.modified, attributes: asRecord(a.attributes) }));
      const out: Record<string, Json> = { source_id: src.id, count: accounts.length, accounts: clip(accounts, max_chars) };
      if (leaks) {
        const leaked = accounts.map((a) => ({ name: a.name, leaked: leakedAttributes(a.attributes) })).filter((a) => Object.keys(a.leaked).length);
        out.leaked_count = leaked.length;
        out.leaked_accounts = leaked;
      }
      return isc.envelope(tenant, { ok: true, ...out });
    }),
  );

  server.registerTool(
    "isc_form_instances",
    {
      title: "Form instances",
      description:
        "Inspect interactive form instances and their formErrors, which name the exact field and reason a submission was " +
        "rejected. Two traps handled here: `state` is NOT a filterable property on the form-instances API (filtering on it " +
        "returns 400), so state is filtered client-side; and a 200 on a submit PATCH does NOT mean the form was submitted. " +
        "A validation failure leaves the instance IN_PROGRESS with the workflow still waiting at its form step.",
      inputSchema: {
        form_definition_id: z.string().optional(),
        state: z.string().optional().describe("Client-side state filter, e.g. IN_PROGRESS, COMPLETED."),
        limit: z.number().int().positive().optional().describe("Max instances (default 25)."),
        tenant: tenantArg,
        max_chars: maxChars,
      },
      annotations: READ,
    },
    async ({ form_definition_id, state, limit = 25, tenant, max_chars = MAX_CHARS_DEFAULT }) => guarded(async () => {
      const { status, body } = await isc.call(tenant, "GET", q("/v2025/form-instances", { filters: form_definition_id ? `formDefinitionId eq "${form_definition_id}"` : undefined, limit }));
      const items = rows(body);
      if (!items) return isc.envelope(tenant, { ok: false, status, body: clip(body, max_chars) });
      const kept = state ? items.filter((i) => String(i.state ?? "").toUpperCase() === state.toUpperCase()) : items;
      const out = kept.slice(0, limit).map((i) => ({ id: i.id, state: i.state, created: i.created, formDefinitionId: i.formDefinitionId, formErrors: i.formErrors, formData: i.formData }));
      return isc.envelope(tenant, { ok: true, count: out.length, instances: clip(out, max_chars) });
    }),
  );

  server.registerTool(
    "isc_compare_tenants",
    {
      title: "Compare two tenants",
      description:
        "Compare one object type across two tenants and report logic drift. READ-ONLY: every call is a GET.\n\n" +
        `object_type: ${COMPARE_TYPES.join(", ")}. Objects pair by name with each tenant's leading environment token stripped.\n\n` +
        "Masked before diffing, because they differ by design: object ids (after url-decoding), OAuth param_oauth/refID, timestamps, " +
        "owners, health and run counters, email addresses, and each tenant's configured environment tokens (set per tenant in VS Code). " +
        "`enabled` is NOT masked. Recipient fields are masked in the logic diff and reported separately under recipient_diffs.\n\n" +
        "Each differing object lists its differing top-level keys and leaf paths with the normalised values. Pass name to diff one object in full.",
      inputSchema: {
        object_type: z.string().describe("One of the listed object types."),
        tenant_a: z.string().optional().describe("First tenant key. With exactly two tenants configured, both may be omitted."),
        tenant_b: z.string().optional().describe("Second tenant key."),
        name: z.string().optional().describe("Diff one object in full."),
        max_paths: z.number().int().positive().optional().describe("Paths per object (default 10, unlimited with name)."),
        max_chars: maxChars,
      },
      annotations: READ,
    },
    async ({ object_type, tenant_a, tenant_b, name, max_paths, max_chars = MAX_CHARS_DEFAULT }) => guarded(async () => {
      const type = COMPARE_ALIASES[object_type] ?? object_type;
      const collect = COLLECTORS[type];
      if (!collect) return { ok: false, error: `object_type must be one of ${COMPARE_TYPES.join(", ")}` };
      let pair: string[];
      if (tenant_a && tenant_b) pair = [tenant_a, tenant_b];
      else if (!tenant_a && !tenant_b && isc.tenants.length === 2) pair = isc.tenants.map((t) => t.key);
      else return { ok: false, error: `pass tenant_a and tenant_b. Configured: ${isc.keys().join(", ")}` };
      const [a, b] = pair.map((k) => isc.resolve(k));
      if (a.key === b.key) return { ok: false, error: "tenant_a and tenant_b must differ" };
      const norm = makeNormaliser([...(a.maskTokens ?? []), ...(b.maskTokens ?? [])]);
      const wantKey = name ? norm.key(name) : null;
      const wanted = (n: string) => wantKey === null || norm.key(n) === wantKey;

      const errors: Record<string, Record<string, Json>[]> = {};
      const view = (key: string): ReadOnlyView => ({
        listing: async (path, paged = true) => {
          const out: Record<string, unknown>[] = [];
          const PAGE = 250;
          for (let offset = 0; offset <= 10_000; offset += PAGE) {
            const full = paged ? q(path, { limit: PAGE, offset }) : path;
            const { status, body } = await isc.call(key, "GET", full);
            if (!isOk(status)) throw new IscError(`GET ${full} on ${key} returned HTTP ${status}: ${JSON.stringify(body).slice(0, 300)}`);
            const page = rows(body);
            if (!page) throw new IscError(`GET ${full} on ${key} returned no recognisable list`);
            out.push(...page);
            if (!paged || page.length < PAGE) break;
          }
          return out;
        },
        sub: async (path) => {
          const { status, body } = await isc.call(key, "GET", path);
          if (isOk(status)) return body;
          if (status !== 404) (errors[key] ??= []).push({ path, status, detail: JSON.stringify(body).slice(0, 200) });
          return null;
        },
      });

      // Separate tenants have separate rate limits, so the two sweeps run side by side.
      let sides: Record<string, unknown>[];
      try {
        sides = await Promise.all([collect(view(a.key), wanted), collect(view(b.key), wanted)]);
      } catch (error) {
        if (error instanceof IscError) return { ok: false, object_type: type, error: error.message };
        throw error;
      }
      const keyed = sides.map((side) => {
        const groups = new Map<string, string[]>();
        for (const orig of Object.keys(side)) {
          const k = norm.key(orig);
          groups.set(k, [...(groups.get(k) ?? []), orig]);
        }
        const byKey = new Map<string, [string, unknown]>();
        const clashes: string[][] = [];
        for (const [k, names] of groups) {
          byKey.set(k, [names[names.length - 1], side[names[names.length - 1]]]);
          if (names.length > 1) clashes.push([...names].sort());
        }
        return { byKey, clashes };
      });
      const inA = new Set(keyed[0].byKey.keys());
      const inB = new Set(keyed[1].byKey.keys());
      if (wantKey !== null && !inA.has(wantKey) && !inB.has(wantKey)) {
        return { ok: false, object_type: type, error: `no ${type} named ${JSON.stringify(name)} in ${a.key} or ${b.key}` };
      }
      const targets = wantKey !== null ? [wantKey] : [...inA].filter((k) => inB.has(k)).sort();
      const pathCap = max_paths ?? (name ? Infinity : 10);

      const differing: Record<string, Json>[] = [];
      const identical: string[] = [];
      const recipientDiffs: Record<string, number> = {};
      let recipientPaths: string[] = [];
      for (const k of targets) {
        if (!inA.has(k) || !inB.has(k)) continue;
        const [aName, aObj] = keyed[0].byKey.get(k)!;
        const [bName, bObj] = keyed[1].byKey.get(k)!;
        const paths = diffObjects(aObj, bObj, norm);
        if (paths.length) {
          const row: Record<string, Json> = { name: aName };
          if (bName !== aName) row[`${b.key}_name`] = bName;
          row.differing_keys = [...new Set(paths.map((p) => topKey(p.path)))].sort();
          row.path_count = paths.length;
          row.paths = paths.slice(0, pathCap).map((p) => ({ path: p.path, [a.key]: short(p.a), [b.key]: short(p.b) }));
          differing.push(row);
        } else identical.push(aName);
        const ra = recipients(aObj);
        const rb = recipients(bObj);
        const rpaths = [...new Set([...Object.keys(ra), ...Object.keys(rb)])].filter((p) => ra[p] !== rb[p]).sort();
        if (rpaths.length) {
          recipientDiffs[aName] = rpaths.length;
          // Paths only, never the addresses: they are personal data and the path says enough.
          if (name) recipientPaths = rpaths;
        }
      }

      // Degrade by thinning per-path detail before clipping: a clipped preview
      // is unparseable, whereas keys and path counts still say where drift is.
      let shown: Record<string, Json>[] = differing;
      let pathsPerObject: number | null = null;
      for (const cap of [3, 1, 0]) {
        if (JSON.stringify(shown).length <= max_chars) break;
        shown = differing.map((r) => {
          if (cap) return { ...r, paths: (r.paths as Json[]).slice(0, cap) };
          const { paths: _paths, ...rest } = r;
          return rest;
        });
        pathsPerObject = cap;
      }
      const out: Record<string, Json> = {
        ok: true,
        object_type: type,
        tenants: { [a.key]: a.label, [b.key]: b.label },
        [`${a.key}_count`]: Object.keys(sides[0]).length,
        [`${b.key}_count`]: Object.keys(sides[1]).length,
        [`only_in_${a.key}`]: [...inA].filter((k) => !inB.has(k)).map((k) => keyed[0].byKey.get(k)![0]).sort(),
        [`only_in_${b.key}`]: [...inB].filter((k) => !inA.has(k)).map((k) => keyed[1].byKey.get(k)![0]).sort(),
        identical_count: identical.length,
        identical: name ? identical : null,
        differing_count: differing.length,
        differing: clip(shown, max_chars),
        recipient_diffs_count: Object.keys(recipientDiffs).length,
        recipient_diffs: recipientDiffs,
        masked_tokens: { [a.key]: a.maskTokens ?? [], [b.key]: b.maskTokens ?? [] },
        note: "Ids, OAuth binds, timestamps, owners, health, run counters, email addresses and each tenant's environment tokens are masked; `enabled` is not. Recipient fields are counted under recipient_diffs, not in differing.",
      };
      if (recipientPaths.length) out.recipient_paths = recipientPaths;
      if (pathsPerObject !== null) out.paths_trimmed = `Showing at most ${pathsPerObject} path(s) per object to fit max_chars; path_count is the true total. Pass name= for one object's full diff, or raise max_chars.`;
      const collisions: Record<string, string[][]> = {};
      keyed.forEach((k, i) => { if (k.clashes.length) collisions[pair[i]] = k.clashes; });
      if (Object.keys(collisions).length) out.name_collisions = collisions;
      if (Object.keys(errors).length) out.fetch_errors = errors;
      return out;
    }),
  );

  /** One JSON-RPC call to the tenant's hosted access-request MCP endpoint. */
  async function hostedRpc(tenant: string | undefined, method: string, params: Json, session?: string): Promise<{ result: Json; session?: string }> {
    const { tenant: t, token } = await isc.token(tenant);
    const payload: Record<string, Json> = { jsonrpc: "2.0", method };
    if (params !== undefined) payload.params = params;
    if (!method.startsWith("notifications/")) payload.id = 1;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": isc.userAgent,
    };
    if (session) headers["Mcp-Session-Id"] = session;
    let res: { status: number; text: string; headers: { get(n: string): string | null } };
    try {
      res = await fetch(`${t.baseUrl}/latest/access-requests/mcp`, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(60_000) })
        .then(async (r) => ({ status: r.status, text: await r.text(), headers: r.headers }));
    } catch (error) {
      return { result: { error: describe(error) }, session };
    }
    if (!isOk(res.status)) return { result: { error: `HTTP ${res.status}`, detail: res.text.slice(0, 500) }, session };
    const sid = res.headers.get("Mcp-Session-Id") ?? session;
    let raw = res.text;
    if (!raw.trim()) return { result: {}, session: sid };
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith("data:")) { raw = line.slice(5).trim(); break; }
    }
    try {
      return { result: JSON.parse(raw), session: sid };
    } catch {
      return { result: { raw: raw.slice(0, 800) }, session: sid };
    }
  }

  server.registerTool(
    "isc_access_requests",
    {
      title: "Hosted access-request tools",
      description:
        "Use SailPoint's own hosted access-request MCP tools (Request Center) through this server: list-requestable, " +
        "view-access-requests, create-access-request, cancel-access-request. It routes to the tenant's hosted endpoint " +
        "with the same auto-refreshing credentials as every other tool. Call with action='list' to see the available " +
        "tools and their exact input schemas, then action='call' with tool_name and arguments. create-access-request " +
        "and cancel-access-request WRITE: they require confirm=true after the user has agreed.",
      inputSchema: {
        action: z.enum(["list", "call"]).optional().describe("list (default) or call."),
        tool_name: z.string().optional(),
        arguments: z.record(z.unknown()).optional(),
        confirm: z.boolean().optional().describe("Required true for create-access-request and cancel-access-request."),
        tenant: tenantArg,
        max_chars: maxChars,
      },
      annotations: WRITE,
    },
    async ({ action = "list", tool_name, arguments: args, confirm, tenant, max_chars = MAX_CHARS_DEFAULT }) => guarded(async () => {
      if (action === "call") {
        if (!tool_name) return isc.envelope(tenant, { ok: false, error: "action='call' needs tool_name" });
        if (/^(create|cancel)-/.test(tool_name) && confirm !== true) {
          return isc.envelope(tenant, { ok: false, refused: `${tool_name} writes to the tenant. Ask the user, then call again with confirm=true.` });
        }
      }
      const init = await hostedRpc(tenant, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "huntaway-isc-mcp", version: "1.0.0" } });
      if (asRecord(init.result).error) return isc.envelope(tenant, { ok: false, stage: "initialize", detail: init.result });
      await hostedRpc(tenant, "notifications/initialized", {}, init.session);
      if (action === "list") {
        const listed = await hostedRpc(tenant, "tools/list", {}, init.session);
        const tools = asList(asRecord(asRecord(listed.result).result).tools);
        return isc.envelope(tenant, { ok: true, action, count: tools.length, tools: clip(tools, max_chars) });
      }
      const called = await hostedRpc(tenant, "tools/call", { name: tool_name, arguments: args ?? {} }, init.session);
      const res = asRecord(called.result);
      return isc.envelope(tenant, { ok: !res.error, action, tool: tool_name, result: clip("result" in res ? res.result : res, max_chars) });
    }),
  );

  server.registerTool(
    "isc_launchers",
    {
      title: "Launchers and who can see them",
      description:
        "Read launchers and, more importantly, WHO CAN SEE THEM. Called bare it lists every launcher with the workflow " +
        "behind it; called with a name or launcher_id it walks the whole chain: launcher, workflow (enabled? step count? " +
        "unbound http steps?), the forms it opens, then the gate entitlement, access profile, role and role MEMBER COUNT.\n\n" +
        "Launcher visibility is an ENTITLEMENT, not an admin user level. A launcher a non-admin cannot see is almost always " +
        "a gate problem: no gate entitlement exists (so only admins see the tile), or the gate role matches zero identities " +
        "because they have not been processed since the criteria changed. The gate entitlement matches on VALUE (the launcher " +
        "id), never on name, so a renamed launcher keeps working and a name search finds nothing. That lookup is done for you.",
      inputSchema: {
        name: z.string().optional(),
        launcher_id: z.string().optional(),
        check_access: z.boolean().optional().describe("Walk the gate chain (default true)."),
        tenant: tenantArg,
        max_chars: maxChars,
      },
      annotations: READ,
    },
    async ({ name, launcher_id, check_access = true, tenant, max_chars = MAX_CHARS_DEFAULT }) => guarded(async () => {
      const { status, body } = await isc.call(tenant, "GET", q("/beta/launchers", { limit: 250 }));
      if (!isOk(status)) return isc.envelope(tenant, { ok: false, status, body: clip(body, max_chars) });
      const items = rows(body) ?? [];
      // One workflow listing serves both modes: a launcher pointing at a
      // disabled workflow looks healthy from the launcher object alone.
      const wfListing = await isc.call(tenant, "GET", "/beta/workflows");
      const wfById = new Map(asList(wfListing.body).map((w) => [String(w.id), w]));
      const refOf = (l: Record<string, unknown>) => String(asRecord(l.reference).id ?? "");

      if (!name && !launcher_id) {
        const list = items
          .map((l) => {
            const wf = wfById.get(refOf(l)) ?? {};
            return { id: l.id, name: l.name, disabled: Boolean(l.disabled), workflow: wf.name, workflow_id: refOf(l) || null, workflow_enabled: wf.enabled, description: l.description };
          })
          .sort((x, y) => lower(x.name).localeCompare(lower(y.name)));
        const broken = list.filter((r) => !r.disabled && r.workflow_enabled === false).map((r) => r.name);
        const env: Record<string, Json> = { ok: true, count: list.length, launchers: clip(list, max_chars) };
        if (broken.length) env.WARNING = `Launcher(s) live but their workflow is DISABLED, so launching fails: ${JSON.stringify(broken)}`;
        return isc.envelope(tenant, env);
      }

      let lid = launcher_id;
      if (!lid && name) {
        const found = matchByName(items, name, "launcher");
        if (!found.match) return isc.envelope(tenant, { ok: false, error: found.error, candidates: found.candidates });
        lid = String(found.match.id);
      }
      const launcher = items.find((l) => l.id === lid);
      if (!launcher) return isc.envelope(tenant, { ok: false, error: `no launcher with id ${JSON.stringify(lid)}` });

      const warnings: string[] = [];
      const result: Record<string, Json> = {
        id: lid, name: launcher.name, disabled: Boolean(launcher.disabled), type: launcher.type,
        description: launcher.description, owner: asRecord(launcher.owner).id, modified: launcher.modified,
      };
      const wid = refOf(launcher);
      if (wid) {
        const one = await isc.call(tenant, "GET", `/beta/workflows/${wid}`);
        if (isOk(one.status) && one.body && typeof one.body === "object") {
          const wf = asRecord(one.body);
          const steps = stepsOf(wf);
          const unbound = httpSteps(steps).filter((h) => !h.bound).map((h) => h.step);
          const forms: Record<string, Json>[] = formSteps(steps);
          if (forms.length) {
            const defs = await isc.call(tenant, "GET", q("/beta/form-definitions", { limit: 100 }));
            const byId = new Map(asList(asRecord(defs.body).results).map((f) => [String(f.id), f.name]));
            for (const f of forms) f.form = byId.get(String(f.formDefinitionId)) ?? null;
          }
          result.workflow = { id: wid, name: wf.name, enabled: Boolean(wf.enabled), step_count: Object.keys(steps).length, step_cap: stepCap, over_cap: Object.keys(steps).length > stepCap, unbound_http_steps: unbound, forms };
          if (!wf.enabled && !launcher.disabled) warnings.push(`Launcher is live but workflow ${JSON.stringify(wf.name)} is DISABLED: launching fails.`);
          if (unbound.length) warnings.push(`Workflow has unbound http step(s) ${JSON.stringify(unbound)}: they fail at runtime and OAuth must be bound by hand in the builder.`);
        } else {
          result.workflow = { id: wid, error: "could not read workflow", status: one.status };
        }
      } else warnings.push("Launcher has no workflow reference.");

      if (check_access) {
        const ents = await isc.call(tenant, "GET", q("/beta/entitlements", { filters: `value eq "${lid}"`, limit: 25 }));
        const entRows = asList(ents.body);
        const gate: Record<string, Json> = { entitlements: entRows.map((e) => ({ id: e.id, name: e.name, source: asRecord(e.source).name })) };
        if (entRows.length) {
          const entIds = new Set(entRows.map((e) => String(e.id)));
          const aps = await isc.call(tenant, "GET", q("/v3/access-profiles", { limit: 250 }));
          const owning = asList(aps.body).filter((a) => asList(a.entitlements).some((x) => entIds.has(String(x.id))));
          gate.access_profiles = owning.map((a) => ({ id: a.id, name: a.name, enabled: a.enabled }));
          const apIds = new Set(owning.map((a) => String(a.id)));
          const roles = await isc.call(tenant, "GET", q("/v3/roles", { limit: 250 }));
          const granting = asList(roles.body).filter((r) => asList(r.accessProfiles).some((p) => apIds.has(String(p.id))));
          const roleRows: Record<string, Json>[] = [];
          for (const r of granting) {
            // Membership is measured, not read off the role: a criteria role
            // reports nothing about who it currently matches.
            const members = await isc.call(tenant, "POST", "/v3/search", { indices: ["identities"], query: { query: `@access(id:"${r.id}")` }, limit: 250 });
            roleRows.push({ id: r.id, name: r.name, enabled: r.enabled, requestable: r.requestable, member_count: Array.isArray(members.body) ? members.body.length : null });
          }
          gate.roles = roleRows;
          if (!owning.length) warnings.push("Gate entitlement exists but NO access profile grants it, so no role can hand it out: only admins will see this launcher.");
          else if (!granting.length) warnings.push("Access profile exists but no ROLE grants it: nobody is gated in.");
          else if (roleRows.every((r) => !r.member_count)) warnings.push("Gate role(s) match ZERO identities. Criteria roles show 0 members until identities are processed; a targeted POST /beta/identities/process usually fixes it within a minute.");
        } else {
          warnings.push("No gate entitlement carries this launcher id as its value, so the tile is visible to admins only. Launcher visibility is entitlement driven, not user level.");
        }
        result.gate = gate;
      }
      if (warnings.length) result.WARNING = warnings.join(" ");
      return isc.envelope(tenant, { ok: true, launcher: result });
    }),
  );

  server.registerTool(
    "isc_dataflow",
    {
      title: "Data flow and source-to-target map",
      description:
        "Derive the tenant's data-flow diagram and attribute-level source-to-target mapping from what it holds: every " +
        "source (authoritative or target), each identity profile's attribute mappings with transforms dereferenced to the " +
        "account attributes they read, each target's CREATE provisioning policy, attribute sync and correlation " +
        "configuration. Emits the Huntaway 'DFD and Source to Target mapping' model (kind huntaway.dataflow): lanes, " +
        "systems, numbered flows, lineage rows grouped per profile and per target, and issues such as a mapping that " +
        "references a missing transform or an undefined identity attribute. With output_path the full model is written " +
        "to that file for opening in Huntaway; the reply then carries the summary and issues. Reads only.",
      inputSchema: {
        title: z.string().optional().describe("Document title (default: the tenant label)."),
        output_path: z.string().optional().describe("Write the full huntaway.dataflow JSON here (absolute path; parent directories are created)."),
        include_model: z.boolean().optional().describe("Include the full model in the reply (default: only when no output_path)."),
        tenant: tenantArg,
        max_chars: maxChars,
      },
      annotations: READ,
    },
    async ({ title, output_path, include_model, tenant, max_chars = MAX_CHARS_DEFAULT }) => guarded(async () => {
      const t = isc.resolve(tenant);
      const gathered = await gather({ get: (path) => isc.call(tenant, "GET", path) });
      if (!gathered.sources.length) {
        return isc.envelope(tenant, { ok: false, error: "no sources could be read", unread: gathered.unread });
      }
      const model = buildDataFlow(gathered, title ?? `${t.label}: data flows and source-to-target mapping`);
      const result: Record<string, Json> = { ok: true, summary: summariseDataFlow(model) };
      if (output_path) {
        const file = resolvePath(output_path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(dataFlowBlock(model), null, 2) + "\n", "utf8");
        result.written = file;
      }
      if (include_model ?? !output_path) result.model = clip(model as unknown as Json, max_chars);
      return isc.envelope(tenant, result);
    }),
  );

  registerNonEmployeeTool(server, isc, { todayOffsetHours: options.todayOffsetHours ?? 0 });

  void nameOf;
}
