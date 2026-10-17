// isc_nonemployee_load: the bulk load as an MCP tool. `plan` is the dry run and
// returns the PLAN DIGEST; `apply`, `restore` and `rollback` need
// confirm: true and, where a plan exists, its digest, and run as background
// JOBS inside this server process because a load settles for minutes; the
// state they need to be resumed lives on disk in the work directory, so a
// server that dies mid-load is recovered by `restore`. `status` reads a job.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IscClient, IscError } from "../isc.js";
import { asList, clip, type Json } from "../util.js";
import { parseProfile, type LoadProfile } from "./profile.js";
import { PlanError, planDigest, planRows, readRows, reference, type Api, type PlanRow, type Reference } from "./plan.js";
import {
  EXIT_INCOMPLETE, RunError, apply, loaderLogins, readJson, restore, rollback, rollbackPlan, unrestoredStates,
  type Outcome, type Results, type Runtime,
} from "./run.js";
import { dayAt, type DateOrder } from "./text.js";

export const WORK_DIR_ENV = "HUNTAWAY_ISC_WORK_DIR";

interface Job {
  id: string;
  kind: string;
  tenant: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "done" | "failed";
  log: string[];
  outcome?: Outcome;
  error?: string;
}

const jobs = new Map<string, Job>();
let jobN = 0;

function sha(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

function workDirFor(tenant: string): string {
  const base = process.env[WORK_DIR_ENV] || join(homedir(), ".huntaway-isc");
  return join(base, tenant);
}

function apiFor(isc: IscClient, tenant: string): Api {
  return {
    get: (path) => isc.call(tenant, "GET", path),
    async search(query, fields, limit = 250) {
      const body: Record<string, Json> = { indices: ["identities"], query: { query }, includeNested: false };
      if (fields) body.queryResultFilter = { includes: fields };
      const { status, body: rows } = await isc.call(tenant, "POST", `/v2025/search?limit=${limit}`, body);
      if (status !== 200 || !Array.isArray(rows)) throw new RunError(`search ${JSON.stringify(query)} failed (HTTP ${status})`);
      return asList(rows);
    },
  };
}

function runtimeFor(isc: IscClient, tenant: string, log: (line: string) => void, todayOffsetHours: number): Runtime {
  return {
    api: apiFor(isc, tenant),
    write: (method, path, body, contentType) => isc.call(tenant, method, path, body as Json, contentType ?? "application/json", 1),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
    todayOffsetHours,
  };
}

interface Loaded {
  profile: LoadProfile;
  profileSha: string;
  fileText?: string;
  fileSha?: string;
}

function loadInputs(profilePath: string, filePath?: string, encoding?: string): Loaded {
  const pp = resolve(profilePath);
  if (!existsSync(pp)) throw new PlanError(`profile not found: ${pp}`);
  const ptext = readFileSync(pp, "utf8");
  const { profile, error } = parseProfile(ptext);
  if (!profile) throw new PlanError(error!);
  const out: Loaded = { profile, profileSha: sha(ptext) };
  if (filePath) {
    const fp = resolve(filePath);
    if (!existsSync(fp)) throw new PlanError(`file not found: ${fp}`);
    const buf = readFileSync(fp);
    const enc = (encoding ?? "utf-8").toLowerCase();
    out.fileText = enc === "utf-8" || enc === "utf8" ? buf.toString("utf8") : new TextDecoder(enc, { fatal: true }).decode(buf);
    out.fileSha = sha(buf);
  }
  return out;
}

const lines = (v: string | undefined) => new Set((v ?? "").split(",").map((x) => x.trim().split("=")[0]).filter((x) => /^[0-9]+$/.test(x)).map(Number));
const lineLogins = (v: string | undefined) => new Map((v ?? "").split(",").map((x) => x.trim()).filter((x) => x.includes("=")).map((x) => [Number(x.split("=")[0]), x.split("=").slice(1).join("=").trim()] as [number, string]));

export interface NonEmployeeToolOptions {
  /** Hours the operator's calendar day runs ahead of UTC (from the tenant's timezone setting; 0 when unknown). */
  todayOffsetHours: number;
}

export function registerNonEmployeeTool(server: McpServer, isc: IscClient, options: NonEmployeeToolOptions): void {
  const inputSchema = {
    action: z.enum(["plan", "apply", "resume", "status", "restore", "rollback", "list"]).describe(
      "plan: dry run, prints LOAD/SKIP per line and the PLAN DIGEST. apply: create the records (needs confirm and plan). " +
      "resume: load the rest of a file after a stopped apply (results_path). status: a running or finished job. " +
      "restore: re-enable the notice workflows a run left off (state_path). rollback: delete the records a results file created " +
      "(dry run without confirm; with confirm and the DELETE PLAN digest it deletes). list: results and STATE files in the work directory.",
    ),
    tenant: z.string().optional().describe("Tenant key. Omit for the default tenant."),
    profile_path: z.string().optional().describe("The load profile JSON (source, login/uid/email rules, columns, reference sources, notice workflows). Required for plan, apply, resume, restore, rollback."),
    file_path: z.string().optional().describe("The tab-separated export. Required for plan, apply, resume."),
    encoding: z.string().optional().describe("File encoding (default utf-8; an Excel tab-delimited save is windows-1252)."),
    date_order: z.enum(["ISO", "MDY", "DMY"]).optional().describe("Only when no day above 12 proves the slash-date order."),
    map: z.record(z.record(z.string())).optional().describe("Per data key, file value to accepted value, e.g. {\"vendor\": {\"Acme Ltd\": \"Acme\"}, \"systemAccessRequired\": {\"FULL\": \"AD-LM\"}}."),
    allow_dup: z.string().optional().describe("Lines allowed to match an existing name, comma separated; LINE=LOGIN accepts the planned login for a same-name-in-file or earlier-run match, e.g. \"4,9=Ann.Lee1\"."),
    allow_preleaver: z.boolean().optional().describe("Load rows that land in preLeaver."),
    allow_ad_inactive: z.string().optional().describe("Lines whose AD column is not active although the row is live, comma separated."),
    allow_value: z.string().optional().describe("Lines allowed a value that needs allowance (e.g. 'Other'), comma separated."),
    show_manager_names: z.boolean().optional(),
    processing_done: z.boolean().optional().describe("Skip the skippable quiet windows (today's identity processing has finished)."),
    known_disabled: z.string().optional().describe("Notice workflows that were off before the run and stay off, comma separated."),
    cap_minutes: z.number().int().positive().optional().describe("Settle wait cap (default from the profile)."),
    plan: z.string().optional().describe("The PLAN DIGEST (apply, resume) or DELETE PLAN digest (rollback) the dry run printed."),
    confirm: z.boolean().optional().describe("Required for apply, resume, restore and a rollback that deletes. Set only after the person has agreed to this specific run."),
    results_path: z.string().optional().describe("A results file in the work directory (resume, rollback)."),
    state_path: z.string().optional().describe("A STATE file in the work directory (restore)."),
    force_restore: z.boolean().optional().describe("restore: re-enable although listed items are open; recorded in the STATE. Never for a rollback's first restore."),
    adopt: z.string().optional().describe("restore: lines whose held record is the line's own, e.g. \"7\" or \"7=<recordId>\"."),
    release: z.string().optional().describe("restore: lines whose held record is a different person; the line loads again on resume."),
    job_id: z.string().optional().describe("status: the job to read."),
    max_chars: z.number().int().positive().optional(),
  };

  server.registerTool(
    "isc_nonemployee_load",
    {
      title: "Bulk load non-employee records",
      description:
        "Bulk-create non-employee records from a tab-separated export the way the tenant's onboarding form would, " +
        "with the notice workflows held off for the duration and re-enabled only once every created identity has settled. " +
        "Everything tenant-specific comes from a profile file you keep beside the data: the source, how logins, uids and " +
        "addresses are formed, column mapping, reference-code sources, the form whose options validate values, which " +
        "workflows go quiet, and quiet windows. Always `plan` first: it validates every row (names, dates, codes, manager " +
        "state, duplicates, free login) and prints a PLAN DIGEST. `apply` is a WRITE and runs as a background job; poll " +
        "`status`. A run that ends with the notices still off names the `restore` to run. `rollback` deletes what a results " +
        "file created. Work files live under ~/.huntaway-isc/<tenant> (or " + WORK_DIR_ENV + ").",
      inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (a) => {
      try {
        const out = await handle(a);
        return { content: [{ type: "text", text: JSON.stringify(out, null, 1) }] };
      } catch (error) {
        if (error instanceof IscError || error instanceof PlanError || error instanceof RunError) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: error.message }) }], isError: true };
        }
        throw error;
      }
    },
  );

  type Args = { [K in keyof typeof inputSchema]: z.infer<(typeof inputSchema)[K]> };

  async function handle(a: Args): Promise<Json> {
    const t = isc.resolve(a.tenant);
    const tenant = t.key;
    const workDir = workDirFor(tenant);
    const envelope = (rest: Record<string, Json>) => isc.envelope(tenant, { work_dir: workDir, ...rest });

    if (a.action === "status") {
      const job = a.job_id ? jobs.get(a.job_id) : [...jobs.values()].filter((j) => j.tenant === tenant).pop();
      if (!job) return envelope({ ok: false, error: "no such job", jobs: [...jobs.values()].map((j) => ({ id: j.id, kind: j.kind, status: j.status, started: j.startedAt })) });
      return envelope({ ok: true, job: { ...job, log: clip(job.log.slice(-80), a.max_chars ?? 20000) } as unknown as Json });
    }
    if (a.action === "list") {
      const left = unrestoredStates(workDir, tenant);
      const files = existsSync(workDir) ? readdirSafe(workDir) : [];
      return envelope({ ok: true, unrestored_states: left, files, jobs: [...jobs.values()].filter((j) => j.tenant === tenant).map((j) => ({ id: j.id, kind: j.kind, status: j.status })) });
    }
    if (!a.profile_path) throw new PlanError("profile_path is required");
    const todayOffset = options.todayOffsetHours;
    const { profile, profileSha, fileText, fileSha } = loadInputs(a.profile_path, a.action === "restore" || a.action === "rollback" ? undefined : a.file_path, a.encoding);
    const api = apiFor(isc, tenant);
    const capMinutes = a.cap_minutes ?? profile.settle.capMinutes;
    const knownDisabled = new Set((a.known_disabled ?? "").split(",").map((x) => x.trim()).filter(Boolean));

    if (a.action === "restore") {
      if (!a.state_path) throw new PlanError("state_path is required");
      if (!a.confirm) throw new PlanError("restore re-enables workflows on the tenant: pass confirm: true after the person has agreed");
      const sp = resolve(a.state_path);
      if (!existsSync(sp)) throw new PlanError(`STATE file not found: ${sp}`);
      return envelope(startJob("restore", tenant, (log) => restore(runtimeFor(isc, tenant, log, todayOffset), profile, {
        statePath: sp, force: Boolean(a.force_restore), capMinutes, adopt: new Map([...lineLogins(a.adopt)].map(([l, r]) => [l, r || null] as [number, string | null]).concat([...lines(a.adopt)].filter((l) => !lineLogins(a.adopt).has(l)).map((l) => [l, null] as [number, string | null]))), release: lines(a.release),
      })));
    }

    const ref: Reference = await reference(api, profile);
    const suppressList = ref.suppress.map((w) => ({ id: w.id, name: w.name }));

    if (a.action === "rollback") {
      if (!a.results_path) throw new PlanError("results_path is required");
      const rp = resolve(a.results_path);
      if (!existsSync(rp)) throw new PlanError(`results file not found: ${rp}`);
      const log: string[] = [];
      if (!a.confirm) {
        const plan = await rollbackPlan(runtimeFor(isc, tenant, (l) => log.push(l), todayOffset), rp);
        return envelope({ ok: true, dry_run: true, delete_plan: plan.digest, to_delete: plan.rows as unknown as Json, gone: plan.gone, held: plan.held, kept: plan.kept, log, next: plan.rows.length ? `rollback again with confirm: true and plan: ${plan.digest}` : "nothing to delete" });
      }
      if (!a.plan) throw new PlanError("pass the DELETE PLAN digest the dry run printed as plan");
      return envelope(startJob("rollback", tenant, (l) => rollback(runtimeFor(isc, tenant, l, todayOffset), profile, { tenant, workDir, resultsPath: rp, digest: a.plan!, suppress: suppressList, knownDisabled, capMinutes })));
    }

    // plan, apply, resume
    if (!fileText || !fileSha || !a.file_path) throw new PlanError("file_path is required");
    const rows = readRows(fileText, profile);
    let skipLines = new Set<number>();
    let resumePath: string | undefined;
    if (a.action === "resume") {
      if (!a.results_path) throw new PlanError("results_path is required for resume");
      resumePath = resolve(a.results_path);
      const prior = readJson<Results>(resumePath);
      if (prior.fileSha256 !== fileSha) throw new PlanError("resume takes the same file as the run it continues (sha differs)");
      skipLines = new Set(prior.created.filter((c) => c.recordId && !c.deleted).map((c) => c.line));
    }
    const nowMs = Date.now();
    const plan: PlanRow[] = await planRows(api, profile, rows, ref, {
      dateOrder: a.date_order as DateOrder | undefined,
      map: a.map ?? {},
      allowDup: lines(a.allow_dup),
      allowDupLogin: lineLogins(a.allow_dup),
      allowPreLeaver: Boolean(a.allow_preleaver),
      allowAdInactive: lines(a.allow_ad_inactive),
      allowValue: lines(a.allow_value),
      showManagerNames: Boolean(a.show_manager_names),
      today: dayAt(nowMs, todayOffset),
      transformToday: dayAt(nowMs, profile.lifecycle.transformDayOffsetHours),
      skipLines,
      loaderLogins: loaderLogins(workDir, tenant),
    });
    const { digest, count } = planDigest(tenant, plan, suppressList.map((s) => s.id), fileSha);
    const listing = plan.filter((p) => p.line).map((p) => ({
      line: p.line,
      verdict: p.done ? "DONE" : p.record ? "LOAD" : "SKIP",
      login: p.login,
      state: p.state,
      errors: p.errors,
      notes: p.notes,
    }));
    const summary = {
      ok: true,
      plan: digest,
      records: count,
      skipped: listing.filter((l) => l.verdict === "SKIP").length,
      suppress: ref.suppress.map((w) => `${w.name} (${w.enabled ? "enabled" : "DISABLED"})`),
      rows: clip(listing as unknown as Json, a.max_chars ?? 20000),
    };
    if (a.action === "plan") return envelope({ ...summary, next: count ? `apply with confirm: true and plan: ${digest}` : "nothing would load" });
    if (!a.confirm) throw new PlanError(`${a.action} creates records on the tenant: pass confirm: true after the person has agreed, with plan: ${digest}`);
    if (a.plan !== digest) throw new PlanError(`plan ${JSON.stringify(a.plan)} is not this plan (${digest}): re-read the dry run`);
    return envelope({
      ...summary,
      ...startJob(a.action, tenant, (log) => apply(runtimeFor(isc, tenant, log, todayOffset), profile, {
        tenant, workDir, plan, digest, file: resolve(a.file_path!), fileSha, profileSha, sourceId: ref.sourceId, suppress: suppressList,
        capMinutes, processingDone: Boolean(a.processing_done), knownDisabled, resume: resumePath,
      })),
    });
  }

  function startJob(kind: string, tenant: string, fn: (log: (line: string) => void) => Promise<Outcome>): Record<string, Json> {
    const job: Job = { id: `job-${++jobN}`, kind, tenant, startedAt: new Date().toISOString(), status: "running", log: [] };
    jobs.set(job.id, job);
    const log = (line: string) => {
      job.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
      if (job.log.length > 2000) job.log.splice(0, job.log.length - 2000);
    };
    void fn(log).then((outcome) => {
      job.outcome = outcome;
      job.status = outcome.exit === EXIT_INCOMPLETE ? "done" : "done";
      job.finishedAt = new Date().toISOString();
      log(`finished: exit ${outcome.exit}${outcome.restore ? `; ${outcome.restore}` : ""}`);
    }).catch((e: unknown) => {
      job.error = e instanceof Error ? e.message : String(e);
      job.status = "failed";
      job.finishedAt = new Date().toISOString();
      log(`failed: ${job.error}`);
    });
    return { job_id: job.id, status: job.status, next: `isc_nonemployee_load action=status job_id=${job.id}` };
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.startsWith("ne-")).sort();
  } catch {
    return [];
  }
}
