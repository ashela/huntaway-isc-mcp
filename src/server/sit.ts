// The SIT harness core, pure where it can be: how an execution's history is
// read for evidence (steps run, sends, cards, failure), how recipients are
// tagged and evidence redacted so no real address reaches a results file,
// the leak check a notification must pass, the case register and the
// results log with their status vocabulary, and the Chain that launches a
// launcher and walks its forms. Case handlers (what to launch with what data
// and what to assert) are the operator's own and live outside the
// extension; these are the primitives every one of them used.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { asList, asRecord, type Json } from "./util.js";

export const STATUSES = ["PASS", "FAIL", "NOTE", "KNOWN", "NA", "ERROR", "BLOCKED"] as const;
export type Status = (typeof STATUSES)[number];
export const FINAL: Status[] = ["PASS", "FAIL", "NOTE", "KNOWN", "NA", "ERROR"];

// ---------------------------------------------------------------- profile

/** What a tenant's SIT needs that the extension must not carry. Optional; without it, no role tags and no launcher exclusions. */
export const SitProfile = z.object({
  version: z.literal(1),
  /** Tag -> regex matched against a lower-cased address, e.g. {"IS": "^identityspecialist@"}. */
  roleMailboxes: z.record(z.string()).default({}),
  /** Address suffixes of generated (throwaway) mailboxes; such an address tags as GENERATED. */
  generatedSuffixes: z.array(z.string()).default([]),
  /** Launchers isc_launch refuses, by exact name (provisioning, deletion). */
  forbiddenLaunchers: z.array(z.string()).default([]),
  /** Form data keys isc_launch refuses to submit (targets a case must not aim at). */
  forbiddenFormKeys: z.array(z.string()).default([]),
  /** A token every onboarding name must carry (fixture isolation), matched case-insensitively after normalisation. */
  fixtureToken: z.string().optional(),
  /** Extra regexes a notification body or subject must not contain. */
  leakPatterns: z.array(z.string()).default([]),
});
export type SitProfile = z.infer<typeof SitProfile>;

export function parseSitProfile(text: string): { profile?: SitProfile; error?: string } {
  try {
    const r = SitProfile.safeParse(JSON.parse(text));
    if (!r.success) return { error: "SIT profile invalid: " + r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
    return { profile: r.data };
  } catch (e) {
    return { error: `SIT profile is not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export const EMPTY_PROFILE: SitProfile = { version: 1, roleMailboxes: {}, generatedSuffixes: [], forbiddenLaunchers: [], forbiddenFormKeys: [], leakPatterns: [] };

// ---------------------------------------------------------------- tagging and redaction

export const EMAIL_RE = /[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/g;

export function norm(s: unknown): string {
  return String(s ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** recipientEmailList / carbonCopy come as a list, a plain string, or a "[a, b]" string. */
export function asAddresses(v: unknown): string[] {
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return [];
  if (Array.isArray(v)) return v.flatMap(asAddresses);
  let s = String(v).trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  return s.split(",").map((p) => p.trim().replace(/^["']|["']$/g, "").toLowerCase()).filter(Boolean);
}

export class Tagger {
  private readonly roles: [string, RegExp][];
  constructor(private readonly profile: SitProfile) {
    this.roles = Object.entries(profile.roleMailboxes).map(([tag, re]) => [tag, new RegExp(re, "i")]);
  }
  /** A role tag, GENERATED, or OTHER:<domain>; a tag handed back stays itself. */
  tag(addr: string): string {
    const raw = String(addr ?? "").trim();
    if (!raw.includes("@")) return raw;
    const a = raw.toLowerCase();
    for (const [tag, re] of this.roles) if (re.test(a)) return tag;
    if (this.profile.generatedSuffixes.some((s) => a.endsWith(s.toLowerCase()))) return "GENERATED";
    return `OTHER:${a.split("@").pop()}`;
  }
  /** Every address in a text replaced by its tag in angle brackets; the domain survives, the local part never does. */
  redact(text: unknown): string {
    return String(text ?? "").replace(EMAIL_RE, (m) => {
      const t = this.tag(m);
      return t.startsWith("OTHER:") ? `<email@${t.slice(6)}>` : `<${t}>`;
    });
  }
}

export function stripHtml(s: unknown): string {
  return String(s ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Template, path, raw-ISO and empty-list leaks a person must never see in a notification. */
export function leakCheck(text: string, profile: SitProfile = EMPTY_PROFILE): string[] {
  const t = text ?? "";
  const bad: string[] = [];
  if (t.includes("{{") || t.includes("}}")) bad.push("{{");
  if (/(?<![\w/])\$\.[A-Za-z]/.test(t)) bad.push("$.path");
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t)) bad.push("ISO");
  if (/(?<![\w])\[\](?![\w])/.test(t)) bad.push("[]");
  for (const s of profile.generatedSuffixes) if (t.toLowerCase().includes(s.toLowerCase())) bad.push("generated-address");
  for (const p of profile.leakPatterns) if (new RegExp(p, "i").test(t)) bad.push(p);
  return bad;
}

// ---------------------------------------------------------------- history

export interface Send {
  step: string;
  technical: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  leaks: string[];
}

export function stepsRun(history: Record<string, unknown>[]): string[] {
  return history.filter((e) => e.type === "ActivityTaskCompleted").map((e) => String(asRecord(e.attributes).stepName ?? "")).filter(Boolean);
}

export function failure(history: Record<string, unknown>[]): string | null {
  for (const e of history) {
    if (e.type === "ActivityTaskFailed" || e.type === "WorkflowExecutionFailed") {
      const a = asRecord(e.attributes);
      return `${String(a.stepName ?? "")}: ${JSON.stringify(a.error ?? a).slice(0, 200)}`;
    }
  }
  return null;
}

export function sends(history: Record<string, unknown>[], tagger: Tagger, profile: SitProfile): Send[] {
  const out: Send[] = [];
  for (const e of history) {
    const a = asRecord(e.attributes);
    if (e.type !== "ActivityTaskScheduled" || a.task !== "sp:send-email") continue;
    const inp = asRecord(a.input);
    const tpl = asRecord(asRecord(inp.body).emailTemplate);
    const subject = String(inp.subject ?? tpl.subject ?? "");
    const body = String(tpl.body ?? (typeof inp.body === "string" ? inp.body : ""));
    out.push({
      step: String(a.stepName ?? ""),
      technical: String(a.technicalName ?? ""),
      to: asAddresses(inp.recipientEmailList).map((x) => tagger.tag(x)),
      cc: asAddresses(inp.carbonCopy ?? asRecord(inp.body).carbonCopy).map((x) => tagger.tag(x)),
      subject: tagger.redact(subject),
      body: tagger.redact(stripHtml(body)).slice(0, 2000),
      leaks: leakCheck(`${subject} ${body}`, profile),
    });
  }
  return out;
}

export function cards(history: Record<string, unknown>[]): { category: string; title: string; message: string }[] {
  const out: { category: string; title: string; message: string }[] = [];
  for (const e of history) {
    const a = asRecord(e.attributes);
    if (e.type !== "ActivityTaskScheduled" || !String(a.task ?? "").includes("interactive-message")) continue;
    const inp = asRecord(a.input);
    const im = asRecord(inp.interactiveMessage ?? inp);
    out.push({
      category: String(im.category ?? asRecord(im.config).category ?? ""),
      title: String(im.title ?? asRecord(im.data).title ?? ""),
      message: stripHtml(im.message ?? asRecord(im.data).message),
    });
  }
  return out;
}

/** The trigger input of an execution: the first history event's input. */
export function execInput(history: Record<string, unknown>[]): Record<string, unknown> {
  return asRecord(asRecord(history[0]?.attributes).input);
}

/** Form instance ids an execution's history names, in order of appearance. */
export function formsInHistory(history: Record<string, unknown>[]): string[] {
  const out: string[] = [];
  for (const e of history) {
    const r = asRecord(asRecord(e.attributes).result);
    const fid = r.formInstanceId ?? asRecord(r.config).formInstanceId;
    if (typeof fid === "string" && !out.includes(fid)) out.push(fid);
  }
  return out;
}

// ---------------------------------------------------------------- case register and results

export interface CaseRow {
  id: string;
  [k: string]: unknown;
}

/** A register is a JSON list of cases with an id, or an object holding such a list under any key. */
export function readRegister(text: string): CaseRow[] {
  const j = JSON.parse(text) as unknown;
  const list = Array.isArray(j) ? j : Object.values(asRecord(j)).find((v) => Array.isArray(v) && v.every((x) => x && typeof x === "object" && "id" in (x as object)));
  if (!Array.isArray(list)) throw new Error("the register is not a list of cases with an id");
  return list.map((c) => c as CaseRow);
}

export interface Verdict {
  case: string;
  status: Status;
  evidence: string;
  ts: string;
  by?: string;
}

export function readResults(path: string): Map<string, Verdict[]> {
  const out = new Map<string, Verdict[]>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as Verdict;
      if (!out.has(v.case)) out.set(v.case, []);
      out.get(v.case)!.push(v);
    } catch {
      /* a half-written line is skipped */
    }
  }
  return out;
}

export function appendResult(path: string, v: Verdict): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(v) + "\n", "utf8");
}

// ---------------------------------------------------------------- the chain

export interface ChainApi {
  get(path: string): Promise<{ status: number; body: Json }>;
  write(method: string, path: string, body: unknown, contentType?: string): Promise<{ status: number; body: Json }>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export class ChainError extends Error {}

export interface FormStep {
  /** Expected form definition name; refused when another form appears. */
  form?: string;
  data: Record<string, unknown>;
}

export interface ChainResult {
  launcher: string;
  workflow: string;
  execution: string;
  status: string;
  forms: { id: string; name: string; state: string; errors: unknown }[];
  steps: string[];
  sends: Send[];
  cards: ReturnType<typeof cards>;
  failure: string | null;
  cancelled: boolean;
}

export interface ChainOptions {
  launcher: string;
  steps: FormStep[];
  /** Cancel the execution after the steps (a pre-check that must create nothing). */
  cancel?: boolean;
  waitSeconds: number;
  profile: SitProfile;
}

/** Launch a launcher and step through its form instances: launch, find the execution by the interactiveProcessId the
 *  launch returned, PATCH each form's formData and state SUBMITTED, then wait for the execution to finish and read its
 *  history for evidence. Only forms this chain opened are ever patched; only this chain's execution is ever cancelled. */
export async function runChain(api: ChainApi, o: ChainOptions): Promise<ChainResult> {
  if (o.profile.forbiddenLaunchers.includes(o.launcher)) throw new ChainError(`launcher ${JSON.stringify(o.launcher)} is excluded by the SIT profile`);
  for (const s of o.steps) {
    const bad = o.profile.forbiddenFormKeys.filter((k) => s.data[k] !== undefined && s.data[k] !== "" && s.data[k] !== null);
    if (bad.length) throw new ChainError(`form data carries excluded key(s) ${bad.join(", ")}`);
    if (o.profile.fixtureToken && ("firstName" in s.data || "lastName" in s.data)) {
      const name = norm(`${String(s.data.firstName ?? "")}${String(s.data.lastName ?? "")}`);
      if (!name.includes(norm(o.profile.fixtureToken))) throw new ChainError(`the name does not carry the fixture token ${o.profile.fixtureToken}`);
    }
  }
  const lres = await api.get("/beta/launchers?limit=250");
  const launchers = asList(Array.isArray(lres.body) ? lres.body : asRecord(lres.body).items);
  const L = launchers.find((x) => x.name === o.launcher);
  if (!L) throw new ChainError(`launcher ${JSON.stringify(o.launcher)} not found`);
  if (L.disabled) throw new ChainError(`launcher ${JSON.stringify(o.launcher)} is disabled`);
  const wid = String(asRecord(L.reference).id ?? "");
  const wres = await api.get(`/v2025/workflows/${wid}`);
  const wfName = String(asRecord(wres.body).name ?? "?");
  const fres = await api.get("/v2025/form-definitions?limit=250");
  const forms = asList(Array.isArray(fres.body) ? fres.body : asRecord(fres.body).results);
  const formName = (fid: unknown) => String(forms.find((f) => f.id === fid)?.name ?? "?");
  const t0 = new Date(api.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const { status, body } = await api.write("POST", `/beta/launchers/${String(L.id)}/launch`, {});
  if (status === 401 || status === 403) throw new ChainError(`launch refused (${status}): the credential's identity does not hold this launcher`);
  if (status < 200 || status >= 300) throw new ChainError(`launch -> ${status} ${JSON.stringify(body).slice(0, 160)}`);
  const pid = String(asRecord(body).interactiveProcessId ?? "");
  // Find the execution this launch started: its input carries the interactiveProcessId.
  let eid = "";
  const histories = new Map<string, Record<string, unknown>[]>();
  const history = async (id: string, fresh = true) => {
    if (fresh || !histories.has(id)) {
      const h = await api.get(`/v2025/workflow-executions/${id}/history`);
      histories.set(id, asList(h.body));
    }
    return histories.get(id)!;
  };
  const end = api.now() + 120_000;
  while (!eid && api.now() < end) {
    const ex = await api.get(`/v2025/workflows/${wid}/executions?filters=${encodeURIComponent(`start_time ge "${t0}"`)}&limit=250`);
    for (const x of asList(ex.body)) {
      const id = String(x.id);
      if (asRecord(execInput(await history(id, false))).interactiveProcessId === pid) {
        eid = id;
        break;
      }
    }
    if (!eid) await api.sleep(5000);
  }
  if (!eid) throw new ChainError(`no execution appeared for launcher ${o.launcher} (interactive process ${pid})`);
  const execution = async () => asRecord((await api.get(`/v2025/workflow-executions/${eid}`)).body);
  const seen: ChainResult["forms"] = [];
  const nextForm = async (expect?: string): Promise<string | null> => {
    const until = api.now() + 150_000;
    for (;;) {
      for (const fid of formsInHistory(await history(eid))) {
        if (seen.some((f) => f.id === fid)) continue;
        const fi = asRecord((await api.get(`/beta/form-instances/${fid}`)).body);
        const name = formName(fi.formDefinitionId);
        seen.push({ id: fid, name, state: String(fi.state ?? ""), errors: fi.formErrors ?? [] });
        if (expect && name !== expect) throw new ChainError(`expected form ${JSON.stringify(expect)}, got ${JSON.stringify(name)}`);
        return fid;
      }
      const st = String((await execution()).status ?? "");
      if (st !== "Executing" || api.now() > until) {
        if (expect) throw new ChainError(`form ${JSON.stringify(expect)} did not appear (execution ${st})`);
        return null;
      }
      await api.sleep(4000);
    }
  };
  let cancelled = false;
  try {
    for (const step of o.steps) {
      const fid = await nextForm(step.form);
      if (!fid) throw new ChainError("no form instance appeared for the next step");
      const { status: st } = await api.write("PATCH", `/beta/form-instances/${fid}`, [
        { op: "replace", path: "/formData", value: step.data },
        { op: "replace", path: "/state", value: "SUBMITTED" },
      ], "application/json-patch+json");
      const back = asRecord((await api.get(`/beta/form-instances/${fid}`)).body);
      const f = seen.find((x) => x.id === fid)!;
      f.state = st >= 200 && st < 300 ? String(back.state ?? "") : `HTTP${st}`;
      f.errors = back.formErrors ?? [];
    }
    if (o.cancel) {
      await api.write("POST", `/beta/workflow-executions/${eid}/cancel`, {});
      cancelled = true;
    }
  } finally {
    /* evidence is read whatever happened above */
  }
  // Wait for the execution to leave Executing, then read the history once more.
  const until = api.now() + o.waitSeconds * 1000;
  let statusNow = String((await execution()).status ?? "");
  while (statusNow === "Executing" && api.now() < until) {
    await api.sleep(8000);
    statusNow = String((await execution()).status ?? "");
  }
  const h = await history(eid);
  const tagger = new Tagger(o.profile);
  return {
    launcher: o.launcher,
    workflow: wfName,
    execution: eid,
    status: statusNow,
    forms: seen,
    steps: stepsRun(h),
    sends: sends(h, tagger, o.profile),
    cards: cards(h),
    failure: failure(h),
    cancelled,
  };
}

// ---------------------------------------------------------------- executions

export const EXEC_FILTER_MARGIN_MS = 120_000;

/** Executions of a workflow since an ISO time. The server's start_time filter drops executions that started in the
 *  same UTC minute as its time and answers 500 for a time in the future, so it is asked from a margin earlier and the
 *  exact cut is made here. */
export async function executionsSince(api: Pick<ChainApi, "get" | "now">, wid: string, since?: string): Promise<Record<string, unknown>[]> {
  const path = `/v2025/workflows/${wid}/executions`;
  if (!since) return asList((await api.get(`${path}?limit=250`)).body);
  const sinceMs = Date.parse(since);
  if (sinceMs > api.now()) return [];
  const wide = new Date(sinceMs - EXEC_FILTER_MARGIN_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
  let rows = asList((await api.get(`${path}?filters=${encodeURIComponent(`start_time ge "${wide}"`)}&limit=250`)).body);
  if (!rows.length) rows = asList((await api.get(`${path}?limit=250`)).body);
  return rows.filter((x) => Date.parse(String(x.startTime ?? "")) >= sinceMs);
}
