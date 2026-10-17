// The SIT tools: the case register with its verdict log (isc_sit_cases),
// execution evidence for a workflow or an identity (isc_workflow_evidence),
// and the launcher-to-form chain (isc_launch, a write that needs confirm).

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IscClient, IscError } from "./isc.js";
import { asList, asRecord, clip, lower, type Json } from "./util.js";
import {
  ChainError, EMPTY_PROFILE, FINAL, STATUSES, Tagger, appendResult, cards, execInput, executionsSince, failure, parseSitProfile,
  readRegister, readResults, runChain, sends, stepsRun, type SitProfile, type Status,
} from "./sit.js";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function loadProfile(path?: string): SitProfile {
  if (!path) return EMPTY_PROFILE;
  const p = resolve(path);
  if (!existsSync(p)) throw new ChainError(`SIT profile not found: ${p}`);
  const { profile, error } = parseSitProfile(readFileSync(p, "utf8"));
  if (!profile) throw new ChainError(error!);
  return profile;
}

async function guarded(fn: () => Promise<Json>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await fn(), null, 1) }] };
  } catch (error) {
    if (error instanceof IscError || error instanceof ChainError || (error instanceof Error && error.message.startsWith("the register"))) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: error.message }) }], isError: true };
    }
    throw error;
  }
}

export function registerSitTools(server: McpServer, isc: IscClient): void {
  const tenantArg = z.string().optional().describe("Tenant key. Omit for the default tenant.");
  const profileArg = z.string().optional().describe("SIT profile JSON: role mailbox regexes for tagging, generated-address suffixes, excluded launchers and form keys, a fixture token.");

  server.registerTool(
    "isc_sit_cases",
    {
      title: "SIT case register and verdicts",
      description:
        "Read a SIT case register (a JSON list of cases with an id and whatever else the register carries: title, steps, " +
        "expected result, persona, launcher) together with its results log (JSONL, one verdict per line, latest wins), and " +
        "record a verdict. Statuses: PASS, FAIL, NOTE (passes but a person must settle something), KNOWN (known defect), " +
        "NA, ERROR (the check broke), BLOCKED (a precondition is missing). Evidence is redacted before it is written: " +
        "addresses become role tags from the SIT profile or <email@domain>. Use list to see what is open, get for one " +
        "case's full text, record to write a verdict after running the case with the other tools.",
      inputSchema: {
        action: z.enum(["list", "get", "record"]),
        register_path: z.string().describe("The case register JSON."),
        results_path: z.string().optional().describe("The results JSONL (default: the register's path with .results.jsonl)."),
        profile_path: profileArg,
        case_id: z.string().optional().describe("get, record: the case id."),
        status: z.enum(STATUSES).optional().describe("record: the verdict."),
        evidence: z.string().optional().describe("record: what was observed, in the case's own terms."),
        filter: z.string().optional().describe("list: substring of the id or title, or a status (OPEN for cases without a final verdict)."),
        max_chars: z.number().int().positive().optional(),
      },
      annotations: { ...READ, readOnlyHint: false, destructiveHint: false },
    },
    async ({ action, register_path, results_path, profile_path, case_id, status, evidence, filter, max_chars = 20000 }) => guarded(async () => {
      const rp = resolve(register_path);
      if (!existsSync(rp)) throw new ChainError(`register not found: ${rp}`);
      const cases = readRegister(readFileSync(rp, "utf8"));
      const resultsFile = resolve(results_path ?? rp.replace(/\.json$/i, "") + ".results.jsonl");
      const results = readResults(resultsFile);
      const last = (id: string) => results.get(id)?.slice(-1)[0];
      if (action === "list") {
        const f = (filter ?? "").trim();
        const rows = cases.filter((c) => {
          const v = last(c.id);
          if (!f) return true;
          if (f.toUpperCase() === "OPEN") return !v || !FINAL.includes(v.status);
          if ((STATUSES as readonly string[]).includes(f.toUpperCase())) return v?.status === f.toUpperCase();
          return c.id.toLowerCase().includes(f.toLowerCase()) || String(c.title ?? "").toLowerCase().includes(f.toLowerCase());
        }).map((c) => ({ id: c.id, title: c.title ?? null, area: c.area ?? null, launcher: c.launcherOrTrigger ?? c.launcher ?? null, status: last(c.id)?.status ?? "OPEN", recorded: last(c.id)?.ts ?? null }));
        const tally: Record<string, number> = {};
        for (const c of cases) {
          const s = last(c.id)?.status ?? "OPEN";
          tally[s] = (tally[s] ?? 0) + 1;
        }
        return { ok: true, register: rp, results: resultsFile, cases: cases.length, tally, rows: clip(rows as unknown as Json, max_chars) };
      }
      if (!case_id) throw new ChainError("case_id is required");
      const c = cases.find((x) => x.id === case_id || x.id.endsWith(case_id));
      if (!c) throw new ChainError(`case ${case_id} is not in the register`);
      if (action === "get") return { ok: true, case: clip(c as unknown as Json, max_chars), verdicts: (results.get(c.id) ?? []) as unknown as Json };
      if (!status) throw new ChainError("status is required");
      const tagger = new Tagger(loadProfile(profile_path));
      const v = { case: c.id, status: status as Status, evidence: tagger.redact(evidence ?? "").slice(0, 6000), ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), by: "huntaway-isc" };
      appendResult(resultsFile, v);
      return { ok: true, recorded: v as unknown as Json, results: resultsFile };
    }),
  );

  server.registerTool(
    "isc_workflow_evidence",
    {
      title: "Workflow execution evidence",
      description:
        "What a workflow actually did: its executions since a time (optionally only those triggered for one identity, " +
        "matched on the trigger input), and for each the status, the steps that completed, every email send with its " +
        "recipients TAGGED (role tags from the SIT profile, GENERATED, or OTHER:<domain>; never a raw address), subject and " +
        "body redacted, a leak check ({{ }}, $.path, raw ISO dates, [], generated addresses), interactive cards, and the " +
        "failing step if any. With wait_seconds it polls until at least `want` executions exist and have finished. " +
        "This is the SIT evidence tool: a case's expected notifications are checked against it.",
      inputSchema: {
        workflow: z.string().describe("Workflow name."),
        since: z.string().optional().describe("ISO UTC time; executions that started at or after it (default: the last 24 hours)."),
        identity_id: z.string().optional().describe("Only executions whose trigger input names this identity."),
        want: z.number().int().positive().optional().describe("With wait_seconds: how many executions to wait for (default 1)."),
        wait_seconds: z.number().int().positive().max(900).optional().describe("Poll for up to this long for the executions to exist and finish."),
        limit: z.number().int().positive().optional().describe("Max executions returned (default 10, newest first)."),
        profile_path: profileArg,
        tenant: tenantArg,
        max_chars: z.number().int().positive().optional(),
      },
      annotations: READ,
    },
    async ({ workflow, since, identity_id, want = 1, wait_seconds, limit = 10, profile_path, tenant, max_chars = 20000 }) => guarded(async () => {
      const profile = loadProfile(profile_path);
      const tagger = new Tagger(profile);
      const api = { get: (p: string) => isc.call(tenant, "GET", p), now: () => Date.now() };
      const wfs = asList((await isc.call(tenant, "GET", "/v2025/workflows?limit=250")).body);
      const wf = wfs.find((w) => lower(w.name) === workflow.toLowerCase());
      if (!wf) return isc.envelope(tenant, { ok: false, error: `no workflow named ${JSON.stringify(workflow)}` });
      const sinceIso = since ?? new Date(Date.now() - 24 * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
      const histories = new Map<string, Record<string, unknown>[]>();
      const history = async (id: string) => {
        if (!histories.has(id)) histories.set(id, asList((await isc.call(tenant, "GET", `/v2025/workflow-executions/${id}/history`)).body));
        return histories.get(id)!;
      };
      const read = async () => {
        let ex = await executionsSince(api, String(wf.id), sinceIso);
        if (identity_id) {
          const kept: Record<string, unknown>[] = [];
          for (const x of ex) if (asRecord(execInput(await history(String(x.id))).identity).id === identity_id) kept.push(x);
          ex = kept;
        }
        return ex.sort((a, b) => String(b.startTime ?? "").localeCompare(String(a.startTime ?? "")));
      };
      let ex = await read();
      const end = Date.now() + (wait_seconds ?? 0) * 1000;
      while (wait_seconds && (ex.length < want || ex.some((x) => x.status === "Executing")) && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 15_000));
        histories.clear();
        ex = await read();
      }
      const out: Record<string, Json>[] = [];
      for (const x of ex.slice(0, limit)) {
        const h = await history(String(x.id));
        out.push({ id: String(x.id), status: String(x.status ?? ""), started: String(x.startTime ?? ""), steps: stepsRun(h), sends: sends(h, tagger, profile) as unknown as Json, cards: cards(h) as unknown as Json, failure: failure(h) });
      }
      return isc.envelope(tenant, { ok: true, workflow: String(wf.name), since: sinceIso, count: ex.length, executions: clip(out, max_chars) });
    }),
  );

  server.registerTool(
    "isc_launch",
    {
      title: "Launch a launcher and walk its forms",
      description:
        "Run a launcher the way a person would: launch it, follow the execution it starts (matched on the interactive " +
        "process id the launch returns, never another run), fill and submit each form instance in turn with the data " +
        "given, optionally cancel at the end (a pre-check that must create nothing), wait for the execution to finish and " +
        "return its evidence: forms seen with their state and formErrors, steps run, sends with tagged recipients, cards, " +
        "failure. Guards: launchers and form keys the SIT profile excludes are refused; with a fixture token, onboarding " +
        "names must carry it; only forms this call opened are ever patched. A WRITE: needs confirm: true.",
      inputSchema: {
        launcher: z.string().describe("Launcher name."),
        steps: z.array(z.object({ form: z.string().optional().describe("Expected form name; refused when another appears."), data: z.record(z.unknown()).describe("formData to submit.") })).describe("Forms in order."),
        cancel: z.boolean().optional().describe("Cancel the execution after the steps."),
        wait_seconds: z.number().int().positive().max(900).optional().describe("How long to wait for the execution to finish (default 240)."),
        profile_path: profileArg,
        confirm: z.boolean().optional().describe("Required. Set only after the person has agreed to this launch with this data."),
        tenant: tenantArg,
        max_chars: z.number().int().positive().optional(),
      },
      annotations: WRITE,
    },
    async ({ launcher, steps, cancel, wait_seconds = 240, profile_path, confirm, tenant, max_chars = 20000 }) => guarded(async () => {
      if (!confirm) return isc.envelope(tenant, { ok: false, error: "isc_launch starts a workflow and submits forms on the tenant: pass confirm: true after the person has agreed" });
      const profile = loadProfile(profile_path);
      const result = await runChain({
        get: (p) => isc.call(tenant, "GET", p),
        write: (m, p, b, ct) => isc.call(tenant, m, p, b as Json, ct ?? "application/json", 1),
        now: () => Date.now(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      }, { launcher, steps: steps as { form?: string; data: Record<string, unknown> }[], cancel, waitSeconds: wait_seconds, profile });
      return isc.envelope(tenant, { ok: true, result: clip(result as unknown as Json, max_chars) });
    }),
  );
}
