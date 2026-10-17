// The apply, its settle gate, the restore and the rollback. Everything that
// writes to the tenant lives here, and every write is preceded by a write
// to disk: the STATE file names the workflows this run holds off before the
// first PATCH, and an entry is in the RESULTS file before its POST. A killed
// process therefore leaves nothing the restore cannot see.
//
// Invariants carried over from the Python loader, verified there across
// twenty review rounds:
//   * the notice workflows are re-enabled ONLY when every loaded identity
//     settled (right uid, held by no other identity, one account on the
//     source, expected state, planned manager, stable over STABLE_S, and
//     unchanged after the final SETTLE_S), and none merged into a
//     pre-existing identity; otherwise they STAY OFF and the restore is
//     named;
//   * a POST answered 0, 5xx or 2xx-without-id is never re-sent: it is
//     looked up by login, and counts as "never landed" only when a good
//     read after the POST found nothing;
//   * a record counts as gone only on two 404 reads;
//   * a workflow whose definition changed while held off is not
//     re-enabled by this tool; the operator enables it by hand;
//   * nothing is deleted on a rollback that is not this results file's own
//     record (source and login re-read) with a known run start.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { asList, asRecord } from "../util.js";
import type { LoadProfile } from "./profile.js";
import { recordsFilter, type Api, type PlanRow } from "./plan.js";
import { ENDED, dayAt, dayFromIso, digest, expectedState, quietOverlap, uidForm } from "./text.js";

export interface Runtime {
  api: Api;
  write(method: string, path: string, body: unknown, contentType?: string): Promise<{ status: number; body: unknown }>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  /** Local wall-clock day offset for the operator's "today" (hours ahead of UTC). */
  todayOffsetHours: number;
}

export const EXIT_CLEAN = 0;
export const EXIT_NOTHING = 1;
export const EXIT_INCOMPLETE = 2;

export interface Entry {
  line: number;
  login: string;
  recordId: string | null;
  uncertain: boolean;
  state: string | null;
  manager: string | null;
  start: string;
  end: string;
  postedAt: string;
  status?: number | string;
  identityId?: string | null;
  resolvedByLogin?: boolean;
  lookedUpAt?: string;
  checkByHand?: string;
  deleted?: string;
  adoptedByHand?: string;
  released?: string;
}

export interface Run {
  started: string;
  t0iso: string;
  plan: string;
  state: string;
  t0: string;
  planned: number[];
  created: Entry[];
  failed: { line: number; login: string; why: string }[];
  stopped?: string;
  notReady?: Record<string, string>;
  merged?: Record<string, string>;
  settledAt?: string;
  reenabledAt?: string;
  reenabledEarlyByOthers?: string[];
  unconfirmedOff?: string[];
  otherChanges?: unknown;
}

export interface Results {
  tool: "huntaway-isc non-employee load";
  tenant: string;
  source: string;
  sourceId: string;
  file: string;
  fileSha256: string;
  profileSha256: string;
  runs: Run[];
  created: Entry[];
  state?: string;
  disabledAt?: string;
  reenabledAt?: string;
  rollbacks?: { at: string; deleted: string[]; state: string }[];
}

export interface HeldWorkflow {
  id: string;
  name: string;
  wasEnabled: boolean;
  defHash: string;
  disabled?: boolean;
  confirmedOff?: boolean;
  reenableTried?: boolean;
  handEnable?: boolean;
  earlyOn?: string;
  definitionChanged?: boolean;
}

export interface State {
  kind: "load" | "delete";
  tenant: string;
  results: string;
  workflows: HeldWorkflow[];
  createdAt: string;
  restoredAt?: string | null;
  forcedRestore?: string[];
  deleteIds?: string[];
}

export const RESULTS_RX = /^ne-load-[a-z0-9-]+-\d{8}-\d{6}-\d+\.json$/;
export const STATE_RX = /^ne-STATE-[a-z0-9-]+-\d{8}-\d{6}-\d+\.json$/;

export function atomicJson(path: string, obj: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 1) + "\n", "utf8");
  renameSync(tmp, path);
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const stamp = (ms: number) => iso(ms).replace(/[-:]/g, "").replace("T", "-").replace("Z", "");
const ts = (s: string | undefined | null) => (s ? Date.parse(s) : NaN);

export function resultsFiles(workDir: string, tenant: string): { path: string; results: Results }[] {
  if (!existsSync(workDir)) return [];
  const out: { path: string; results: Results }[] = [];
  for (const f of readdirSync(workDir).sort()) {
    if (!RESULTS_RX.test(f) || !f.startsWith(`ne-load-${tenant}-`)) continue;
    try {
      const r = readJson<Results>(join(workDir, f));
      if (r && Array.isArray(r.created)) out.push({ path: join(workDir, f), results: r });
    } catch {
      /* an unreadable results file is reported by preflight */
    }
  }
  return out;
}

export function liveCreated(r: Results): Entry[] {
  return r.created.filter((c) => c && !c.deleted);
}

/** Logins earlier runs created on this tenant and did not delete. */
export function loaderLogins(workDir: string, tenant: string): Set<string> {
  const out = new Set<string>();
  for (const { results } of resultsFiles(workDir, tenant)) for (const c of liveCreated(results)) if (c.recordId || !c.released) out.add(c.login.toLowerCase());
  return out;
}

export function unrestoredStates(workDir: string, tenant: string): string[] {
  if (!existsSync(workDir)) return [];
  const out: string[] = [];
  for (const f of readdirSync(workDir).sort()) {
    if (!STATE_RX.test(f) || !f.startsWith(`ne-STATE-${tenant}-`)) continue;
    try {
      const s = readJson<State>(join(workDir, f));
      if (s.workflows.some((w) => w.disabled) && !s.restoredAt) out.push(join(workDir, f));
    } catch {
      out.push(join(workDir, f));
    }
  }
  return out;
}

// ---------------------------------------------------------------- lock

export class Lock {
  private path: string;
  constructor(workDir: string, private readonly what: string) {
    this.path = join(workDir, "ne.lock");
  }
  take(): void {
    mkdirSync(join(this.path, ".."), { recursive: true });
    if (existsSync(this.path)) {
      try {
        const held = readJson<{ pid: number; what: string; at: string }>(this.path);
        if (held.pid === process.pid) return;
        let alive = false;
        try {
          process.kill(held.pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
        if (alive) throw new RunError(`another ${held.what} (pid ${held.pid}, since ${held.at}) holds the lock: one apply at a time`);
      } catch (e) {
        if (e instanceof RunError) throw e;
      }
      unlinkSync(this.path);
    }
    writeFileSync(this.path, JSON.stringify({ pid: process.pid, what: this.what, at: new Date().toISOString() }), { flag: "wx" });
  }
  drop(): void {
    try {
      const held = readJson<{ pid: number }>(this.path);
      if (held.pid === process.pid) unlinkSync(this.path);
    } catch {
      /* nothing to drop */
    }
  }
}

export class RunError extends Error {}

// ---------------------------------------------------------------- reads

const q = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;

async function wfGet(rt: Runtime, id: string): Promise<Record<string, unknown> | null> {
  const { status, body } = await rt.api.get(`/v2025/workflows/${id}`);
  return status === 200 && body && typeof body === "object" ? (body as Record<string, unknown>) : null;
}

export async function snapshot(rt: Runtime, watch: string[]): Promise<Record<string, unknown[]>> {
  const fields = ["id", "manager.id", ...watch.map((k) => `attributes.${k}`)];
  const rows = await rt.api.search("*", fields, 10000);
  if (rows.length >= 10000) throw new RunError("identity snapshot hit 10000 rows: this tenant needs a paged snapshot before a load");
  const out: Record<string, unknown[]> = {};
  for (const x of rows) {
    const a = asRecord(x.attributes);
    out[String(x.id)] = [...watch.map((k) => a[k] ?? null), asRecord(x.manager).id ?? null];
  }
  return out;
}

async function sourceIndex(rt: Runtime, sourceId: string): Promise<Map<string, Record<string, unknown>> | null> {
  const out = new Map<string, Record<string, unknown>>();
  for (let offset = 0; ; offset += 250) {
    const { status, body } = await rt.api.get(`${recordsFilter(sourceId)}&limit=250&offset=${offset}`);
    if (status !== 200) return null;
    const rows = asList(body);
    for (const r of rows) out.set(String(r.accountName ?? "").toLowerCase(), r);
    if (rows.length < 250) return out;
  }
}

async function identityFor(rt: Runtime, sourceId: string, recordId: string): Promise<Record<string, unknown> | null> {
  const f = encodeURIComponent(`sourceId eq "${sourceId}" and nativeIdentity eq "${recordId}"`);
  const { status, body } = await rt.api.get(`/v2025/accounts?filters=${f}`);
  const accs = asList(body);
  const iid = status === 200 && accs.length ? String(accs[0].identityId ?? "") : "";
  if (!iid) return null;
  const i = await rt.api.get(`/v2025/identities/${iid}`);
  return i.status === 200 && asRecord(i.body).id ? (i.body as Record<string, unknown>) : null;
}

async function accountsOn(rt: Runtime, sourceId: string, identityId: string): Promise<number | null> {
  const f = encodeURIComponent(`identityId eq "${identityId}" and sourceId eq "${sourceId}"`);
  const { status, body } = await rt.api.get(`/v2025/accounts?filters=${f}`);
  return status === 200 && Array.isArray(body) ? body.length : null;
}

/** Look uncertain creates up by login. A match outside the POST window is kept for a check by hand, never adopted. */
async function resolveUncertain(rt: Runtime, sourceId: string, entries: Entry[], rejected?: Map<string, [string, string]>): Promise<boolean> {
  const idx = await sourceIndex(rt, sourceId);
  if (!idx) return false;
  const when = iso(rt.now());
  for (const c of entries) {
    if (!(c.uncertain && !c.recordId) || c.released || c.checkByHand) continue;
    const rec = idx.get(c.login.toLowerCase());
    if (!rec) {
      c.lookedUpAt = when;
      continue;
    }
    const made = ts(String(rec.created ?? ""));
    const posted = ts(c.postedAt);
    const within = Number.isNaN(made) || Number.isNaN(posted) ? false : Math.abs(made - posted) <= 10 * 60_000;
    if (within) {
      c.recordId = String(rec.id);
      c.uncertain = false;
      c.resolvedByLogin = true;
    } else {
      c.checkByHand = String(rec.id);
      rejected?.set(c.login, [String(rec.id), `created ${String(rec.created ?? "?")}, POST ${c.postedAt}: not within 10 minutes`]);
    }
  }
  return true;
}

// ---------------------------------------------------------------- settle

function sigOf(i: Record<string, unknown> | null, profile: LoadProfile): string {
  const a = asRecord(i?.attributes);
  return JSON.stringify([a.identityType, a.cloudLifecycleState, asRecord(i?.managerRef).id, a.uid, i?.processingState, ...profile.settle.requireAttributes.map((k) => a[k])]);
}

function entryStates(c: Entry, profile: LoadProfile, nowMs: number, todayOffset: number): Set<string> {
  const out = new Set<string>();
  if (c.state) out.add(c.state);
  const start = dayFromIso(c.start);
  const end = dayFromIso(c.end);
  if (start && end) {
    for (const off of [todayOffset, profile.lifecycle.transformDayOffsetHours]) out.add(expectedState(start, end, dayAt(nowMs, off), profile.lifecycle));
  }
  return out;
}

function identityProblem(i: Record<string, unknown> | null, c: Entry, mgrId: string | null | undefined, profile: LoadProfile, rt: Runtime): string | null {
  if (!i) return "no identity yet";
  const a = asRecord(i.attributes);
  if (a.identityType !== profile.lifecycle.identityType) return `identityType ${String(a.identityType)}`;
  const want = (profile.uidPrefix + uidForm(c.login)).toLowerCase();
  if (String(a.uid ?? "").toLowerCase() !== want) return `uid ${String(a.uid ?? "not set")}, expected ${want} (its account joined another identity?)`;
  const ok = entryStates(c, profile, rt.now(), rt.todayOffsetHours);
  if (!ok.has(String(a.cloudLifecycleState))) return `state ${String(a.cloudLifecycleState)}, expected ${[...ok].sort().join("/")}`;
  if (c.manager) {
    const ref = asRecord(i.managerRef).id;
    if (!ref) return "no manager yet";
    if (!mgrId) return `the planned manager ${c.manager} no longer resolves to one identity`;
    if (ref !== mgrId) return "manager not the planned one yet";
  }
  for (const k of profile.settle.requireAttributes) if (!a[k]) return `${k} not set`;
  if (i.processingState === "ERROR") return "processingState ERROR";
  return null;
}

function preExisting(i: Record<string, unknown> | null, t0ms: number): boolean {
  const made = ts(String(i?.created ?? ""));
  return !Number.isNaN(made) && made < t0ms - 10 * 60_000;
}

export interface Settled {
  complete: boolean;
  notReady: Record<string, string>;
  merged: Record<string, string>;
  interrupted: boolean;
}

export const NEVER_LANDED = "no record found by login after its POST (the POST did not land)";
export const NOT_LOOKED_UP = "not looked up: the source could not be read after its POST";

function noRecordReason(c: Entry): string {
  const looked = ts(c.lookedUpAt);
  const posted = ts(c.postedAt);
  return !Number.isNaN(looked) && (Number.isNaN(posted) || looked >= posted) ? NEVER_LANDED : NOT_LOOKED_UP;
}

/** Waits for every entry's identity to pass identityProblem, hold one account on the source, own its uid alone and
 *  read the same over stableSeconds; then settleSeconds and a re-read that must match. Never throws. */
export async function settle(rt: Runtime, profile: LoadProfile, sourceId: string, created: Entry[], t0ms: number, mgrIds: Map<string, string | null>, capS: number, tail = false): Promise<Settled> {
  const seen = new Map<string, [string, number]>();
  const ready = new Set<string>();
  const merged: Record<string, string> = {};
  const why: Record<string, string> = {};
  const rejected = new Map<string, [string, string]>();
  let interrupted = false;
  const tEnd = rt.now() + capS * 1000;
  const read = async (c: Entry): Promise<[Record<string, unknown> | null, string]> => {
    const i = await identityFor(rt, sourceId, c.recordId!);
    const n = i ? await accountsOn(rt, sourceId, String(i.id)) : null;
    return [i, sigOf(i, profile) + `|${n}`];
  };
  try {
    while (rt.now() < tEnd) {
      if (created.some((c) => !c.recordId)) await resolveUncertain(rt, sourceId, created, rejected);
      const pending = created.filter((c) => c.recordId && !ready.has(c.recordId) && !(c.recordId in merged));
      if (!pending.length && !created.some((c) => !c.recordId)) break;
      for (const c of pending) {
        const [i, sig] = await read(c);
        if (!i) {
          why[c.login] = "no identity yet";
          continue;
        }
        c.identityId = String(i.id);
        if (preExisting(i, t0ms)) {
          merged[c.recordId!] = String(i.id);
          continue;
        }
        let p = identityProblem(i, c, mgrIds.get(c.manager ?? ""), profile, rt);
        const n = Number(sig.split("|").pop());
        if (!p && n !== 1) p = `its identity holds ${n} accounts on the source (shared with another record?)`;
        if (!p) {
          try {
            const holders = await rt.api.search(`attributes.uid.exact:${q((profile.uidPrefix + uidForm(c.login)).toLowerCase())}`, ["id"], 5);
            const ids = holders.map((x) => String(x.id));
            if (ids.length !== 1 || ids[0] !== String(i.id)) p = `its uid is held by ${ids.length} identities (${ids.length > 1 ? "an accent-only twin? waiting will not clear it" : "not indexed yet"})`;
          } catch (e) {
            p = `the uid holders could not be read (${e instanceof Error ? e.message : String(e)})`;
          }
        }
        const prev = seen.get(c.recordId!);
        if (!p && prev && prev[0] === sig && rt.now() - prev[1] >= profile.settle.stableSeconds * 1000) ready.add(c.recordId!);
        else if (!prev || prev[0] !== sig) seen.set(c.recordId!, [sig, rt.now()]);
        why[c.login] = p ?? `not yet stable over ${profile.settle.stableSeconds} s`;
      }
      rt.log(`identities ready ${ready.size}/${created.length}, merged ${Object.keys(merged).length}`);
      if (ready.size + Object.keys(merged).length >= created.length) break;
      await rt.sleep(20_000);
    }
    let complete = ready.size === created.length && !Object.keys(merged).length;
    if ((complete || tail) && ready.size) {
      rt.log(`settle ${profile.settle.settleSeconds}s`);
      await rt.sleep(profile.settle.settleSeconds * 1000);
      for (const c of created) {
        if (!c.recordId || !ready.has(c.recordId)) continue;
        const [i, sig] = await read(c);
        if (sig !== seen.get(c.recordId)![0]) {
          ready.delete(c.recordId);
          why[c.login] = i ? `changed during the final ${profile.settle.settleSeconds} s settle` : "could not be re-read after the settle";
          complete = false;
        }
      }
    }
    const notReady: Record<string, string> = {};
    for (const c of created) {
      if (c.recordId && (ready.has(c.recordId) || c.recordId in merged)) continue;
      if (!c.recordId && rejected.has(c.login)) {
        const [rid, r] = rejected.get(c.login)!;
        notReady[c.login] = `record ${rid} has this login but ${r}: check by hand (adopt or release the line)`;
        continue;
      }
      notReady[c.login] = !c.recordId ? noRecordReason(c) : why[c.login] ?? "not read yet";
    }
    return { complete, notReady, merged, interrupted };
  } catch (e) {
    rt.log(`!! settle stopped: ${e instanceof Error ? e.message : String(e)}`);
    interrupted = true;
    const notReady: Record<string, string> = {};
    for (const c of created) if (!(c.recordId && (ready.has(c.recordId) || c.recordId in merged))) notReady[c.login] = why[c.login] ?? "interrupted";
    return { complete: false, notReady, merged, interrupted };
  }
}

// ---------------------------------------------------------------- suppression

async function suppress(rt: Runtime, state: State, statePath: string): Promise<void> {
  for (const w of state.workflows) {
    if (!w.wasEnabled) continue;
    w.disabled = true; // recorded before the PATCH: a restore re-enables it whatever happens
    atomicJson(statePath, state);
    const { status } = await rt.write("PATCH", `/v2025/workflows/${w.id}`, [{ op: "replace", path: "/enabled", value: false }], "application/json-patch+json");
    const cur = await wfGet(rt, w.id);
    rt.log(`disable ${w.name} -> ${status} | enabled ${String(cur?.enabled)}`);
    if (!(cur && cur.enabled === false)) throw new RunError(`could not confirm ${w.name} disabled (PATCH ${status})`);
    w.confirmedOff = true;
    atomicJson(statePath, state);
  }
}

async function earlyOn(rt: Runtime, state: State, statePath: string): Promise<{ early: string[]; unreadable: string[] }> {
  const unreadable: string[] = [];
  for (const w of state.workflows) {
    if (!(w.disabled && w.confirmedOff) || w.reenableTried || w.handEnable || w.earlyOn) continue;
    let cur: Record<string, unknown> | null = null;
    for (let k = 0; k < 3 && !cur; k++) {
      cur = await wfGet(rt, w.id);
      if (!cur) await rt.sleep(5000);
    }
    if (!cur) unreadable.push(w.name);
    else if (cur.enabled !== false) {
      w.earlyOn = iso(rt.now());
      atomicJson(statePath, state);
    }
  }
  return { early: state.workflows.filter((w) => w.earlyOn).map((w) => w.name), unreadable };
}

/** Re-enable every workflow the STATE says was disabled (idempotent). Returns the names not confirmed enabled. */
async function reenable(rt: Runtime, state: State, statePath: string): Promise<string[]> {
  const bad: string[] = [];
  for (const w of state.workflows) {
    if (!w.wasEnabled || !w.disabled) continue;
    try {
      const cur = await wfGet(rt, w.id);
      if (!cur) {
        bad.push(w.name);
        rt.log(`${w.name} UNREADABLE: not re-enabled: run restore again`);
        continue;
      }
      if (cur.enabled === true) {
        w.disabled = false;
        atomicJson(statePath, state);
        rt.log(`${w.name} ${w.handEnable ? "enabled by hand as instructed: recorded" : `already enabled${w.earlyOn ? " (re-enabled by someone else while held off)" : ""}`}`);
        continue;
      }
      if (digest(cur.definition) !== w.defHash) {
        bad.push(w.name);
        w.definitionChanged = w.handEnable = true;
        atomicJson(statePath, state);
        rt.log(`${w.name} NOT re-enabled: its definition changed since the disable: review the change, enable it by hand; restore then records it`);
        continue;
      }
      w.reenableTried = true;
      atomicJson(statePath, state);
      let ok = false;
      for (let k = 0; k < 6 && !ok; k++) {
        await rt.write("PATCH", `/v2025/workflows/${w.id}`, [{ op: "replace", path: "/enabled", value: true }], "application/json-patch+json");
        const back = await wfGet(rt, w.id);
        ok = Boolean(back && back.enabled === true);
        if (!ok) await rt.sleep(5000 * (k + 1));
      }
      if (!ok) {
        bad.push(w.name);
        w.handEnable = true;
        atomicJson(statePath, state);
        rt.log(`${w.name} FAILED to re-enable: run restore again, or enable it by hand`);
        continue;
      }
      w.disabled = false;
      atomicJson(statePath, state);
      rt.log(`${w.name} enabled`);
    } catch (e) {
      bad.push(w.name);
      rt.log(`${w.name} FAILED (${e instanceof Error ? e.message : String(e)}): run restore again`);
    }
  }
  state.restoredAt = bad.length ? null : iso(rt.now());
  atomicJson(statePath, state);
  return bad;
}

async function newState(rt: Runtime, workDir: string, tenant: string, kind: "load" | "delete", resultsPath: string, suppressList: { id: string; name: string }[]): Promise<{ state: State; statePath: string }> {
  const statePath = join(workDir, `ne-STATE-${tenant}-${stamp(rt.now())}-${process.pid}.json`);
  const workflows: HeldWorkflow[] = [];
  for (const w of suppressList) {
    const cur = await wfGet(rt, w.id);
    if (!cur) throw new RunError(`${w.name} could not be read: nothing disabled`);
    workflows.push({ id: w.id, name: w.name, wasEnabled: cur.enabled === true, defHash: digest(cur.definition) });
  }
  const state: State = { kind, tenant, results: resultsPath, workflows, createdAt: iso(rt.now()) };
  atomicJson(statePath, state);
  return { state, statePath };
}

async function preflight(rt: Runtime, workDir: string, tenant: string, suppressList: { id: string; name: string }[], knownDisabled: Set<string>): Promise<void> {
  const left = unrestoredStates(workDir, tenant);
  if (left.length) throw new RunError(`an earlier run left notice workflows disabled: run restore on ${basename(left[0])} first`);
  const off: string[] = [];
  for (const w of suppressList) {
    const cur = await wfGet(rt, w.id);
    if (!cur) throw new RunError(`${w.name} could not be read: nothing disabled`);
    if (cur.enabled !== true && !knownDisabled.has(w.name)) off.push(w.name);
  }
  if (off.length) throw new RunError(`notice workflows are disabled now (${off.join(", ")}): find out why (restore an earlier STATE) or name them in known_disabled to leave them as they are`);
}

async function resolveManagers(rt: Runtime, uids: Set<string>): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const uid of uids) {
    if (!uid) continue;
    const hits = await rt.api.search(`attributes.uid.exact:${q(uid)}`, ["id"], 5);
    out.set(uid, hits.length === 1 ? String(hits[0].id) : null);
  }
  return out;
}

async function afterChecks(rt: Runtime, profile: LoadProfile, run: Run, t0: Record<string, unknown[]> | null, loadedIds: Set<string>): Promise<void> {
  try {
    if (!t0) {
      run.otherChanges = "not checked (T0 missing)";
      return;
    }
    const t1 = await snapshot(rt, profile.watch);
    run.otherChanges = Object.entries(t1).filter(([i, v]) => !loadedIds.has(i) && JSON.stringify(t0[i]) !== JSON.stringify(v)).map(([i, v]) => ({ id: i, before: t0[i] ?? null, after: v }));
  } catch (e) {
    run.otherChanges = `not checked (${e instanceof Error ? e.message : String(e)})`;
  }
}

// ---------------------------------------------------------------- apply

export interface ApplyOptions {
  tenant: string;
  workDir: string;
  plan: PlanRow[];
  digest: string;
  file: string;
  fileSha: string;
  profileSha: string;
  sourceId: string;
  suppress: { id: string; name: string }[];
  capMinutes: number;
  processingDone: boolean;
  knownDisabled: Set<string>;
  /** Resume: the results file this run continues. */
  resume?: string;
}

export interface Outcome {
  exit: number;
  results?: string;
  state?: string;
  created: number;
  failed: number;
  issues: string[];
  /** The command to run when the notices are still off. */
  restore?: string;
}

export async function apply(rt: Runtime, profile: LoadProfile, o: ApplyOptions): Promise<Outcome> {
  const todo = o.plan.filter((p) => p.record);
  if (!todo.length) return { exit: EXIT_NOTHING, created: 0, failed: 0, issues: ["nothing to load"] };
  const capS = Math.max(o.capMinutes * 60, todo.length * 25);
  const tailS = capS + profile.settle.settleSeconds + profile.settle.stableSeconds + 300;
  const est = rt.now() + (300 + todo.length * profile.settle.secondsPerRow + tailS) * 1000;
  const clash = quietOverlap(rt.now(), est, profile.quietWindows, o.processingDone);
  if (clash) throw new RunError(`the run (to about ${iso(est)}) would overlap ${clash}: no apply`);
  const lock = new Lock(o.workDir, "load");
  lock.take();
  try {
    await preflight(rt, o.workDir, o.tenant, o.suppress, o.knownDisabled);
    const mgrIds = await resolveManagers(rt, new Set(todo.map((p) => String(p.record!.manager ?? ""))));
    const lost = [...mgrIds].filter(([, i]) => !i).map(([u]) => u);
    if (lost.length) throw new RunError(`manager uid ${lost.join(", ")} no longer resolves to exactly one identity: re-run the plan: nothing disabled`);
    const resultsPath = o.resume ?? join(o.workDir, `ne-load-${o.tenant}-${stamp(rt.now())}-${process.pid}.json`);
    const res: Results = o.resume
      ? readJson<Results>(o.resume)
      : { tool: "huntaway-isc non-employee load", tenant: o.tenant, source: profile.source, sourceId: o.sourceId, file: o.file, fileSha256: o.fileSha, profileSha256: o.profileSha, runs: [], created: [] };
    const { state, statePath } = await newState(rt, o.workDir, o.tenant, "load", resultsPath, o.suppress);
    let t0: Record<string, unknown[]> | null = null;
    try {
      t0 = await snapshot(rt, profile.watch);
    } catch (e) {
      try {
        unlinkSync(statePath);
      } catch {
        /* holds nothing disabled yet */
      }
      throw new RunError(`T0 snapshot failed (${e instanceof Error ? e.message : String(e)}): nothing disabled`);
    }
    const t0Path = statePath.replace("-STATE-", "-T0-");
    atomicJson(t0Path, t0);
    const t0ms = rt.now();
    const run: Run = { started: iso(t0ms), t0iso: iso(t0ms), plan: o.digest, state: statePath, t0: t0Path, planned: todo.map((p) => p.line), created: [], failed: [] };
    res.runs.push(run);
    res.state = statePath;
    res.disabledAt = iso(rt.now());
    delete res.reenabledAt;
    atomicJson(resultsPath, res);
    rt.log(`STATE ${statePath}`);
    rt.log(`RESULTS ${resultsPath}`);
    try {
      await suppress(rt, state, statePath);
      const index = (await sourceIndex(rt, o.sourceId)) ?? new Map();
      for (const p of todo) {
        const rec = p.record!;
        const login = String(rec.accountName);
        const left = todo.length - run.created.length - run.failed.length;
        const ahead = quietOverlap(rt.now(), rt.now() + (300 + left * profile.settle.secondsPerRow + tailS) * 1000, profile.quietWindows, o.processingDone);
        if (ahead) {
          run.stopped = `quiet window ahead: ${ahead}`;
          rt.log(`!! ${run.stopped}: creates stopped`);
          break;
        }
        const uid = profile.uidPrefix + uidForm(login);
        const nameTaken = (await rt.api.search(`name:${q(login)}`, ["name"], 5)).some((x) => String(x.name ?? "").toLowerCase() === login.toLowerCase());
        const uidTaken = (await rt.api.search(`attributes.uid.exact:${q(uid)}`, ["id"], 5)).length > 0;
        if (index.has(login.toLowerCase()) || nameTaken || uidTaken) {
          run.failed.push({ line: p.line, login, why: `login or uid ${uid} taken since the plan` });
          atomicJson(resultsPath, res);
          rt.log(`line ${p.line} ${login} -> skipped: login or uid taken since the plan`);
          continue;
        }
        const entry: Entry = { line: p.line, login, recordId: null, uncertain: true, state: p.state, manager: rec.manager ? String(rec.manager) : null, start: String(rec.startDate).slice(0, 10), end: String(rec.endDate).slice(0, 10), postedAt: iso(rt.now()) };
        run.created.push(entry);
        res.created.push(entry);
        atomicJson(resultsPath, res); // write-ahead: an interrupted POST is still tracked by login
        const { status, body } = await rt.write("POST", "/v2025/non-employee-records", rec);
        entry.status = status;
        const rid = asRecord(body).id ? String(asRecord(body).id) : null;
        const ok2xx = status >= 200 && status <= 299;
        if (ok2xx && rid) {
          entry.recordId = rid;
          entry.uncertain = false;
        } else if (ok2xx || status === 0 || (status >= 500 && status <= 599)) {
          for (let k = 0; k < 3 && !entry.recordId; k++) {
            await rt.sleep(10_000);
            await resolveUncertain(rt, o.sourceId, [entry]);
          }
        } else {
          run.created.splice(run.created.indexOf(entry), 1);
          res.created.splice(res.created.indexOf(entry), 1);
          run.failed.push({ line: p.line, login, why: `${status} ${JSON.stringify(body).slice(0, 200)}` });
          atomicJson(resultsPath, res);
          rt.log(`line ${p.line} ${login} -> failed ${status}`);
          continue;
        }
        if (entry.recordId) index.set(login.toLowerCase(), { id: entry.recordId });
        atomicJson(resultsPath, res);
        rt.log(`line ${p.line} ${login} -> ${entry.uncertain ? `UNCERTAIN (status ${status}): looked up by login during the settle` : "created"}`);
      }
    } catch (e) {
      run.stopped = e instanceof Error ? e.message : String(e);
      rt.log(`!! load stopped: ${run.stopped}`);
    }
    let why: string | null = null;
    try {
      const s = await settle(rt, profile, o.sourceId, run.created, t0ms, mgrIds, capS);
      run.notReady = s.notReady;
      run.merged = s.merged;
      if (s.complete) run.settledAt = iso(rt.now());
      const { early, unreadable } = await earlyOn(rt, state, statePath);
      if (early.length) {
        run.reenabledEarlyByOthers = early;
        rt.log(`!! ${early.join(", ")} came back on during the load (another writer): notices may have fired for loaded records`);
      }
      if (unreadable.length) {
        run.unconfirmedOff = unreadable;
        rt.log(`!! ${unreadable.join(", ")} could not be read to confirm they stayed off`);
      }
      atomicJson(resultsPath, res);
      if (!s.complete || early.length || unreadable.length) {
        const parts: string[] = [];
        if (s.interrupted) parts.push("interrupted while waiting for the identities");
        const noRec = Object.entries(s.notReady).filter(([, v]) => v === NEVER_LANDED || v === NOT_LOOKED_UP).map(([k]) => k);
        const unsettled = Object.entries(s.notReady).filter(([k]) => !noRec.includes(k)).map(([k, v]) => `${k} (${v})`);
        if (noRec.length) parts.push(`no record known for ${noRec.join(", ")}`);
        if (unsettled.length) parts.push(`identities not settled: ${unsettled.join("; ")}`);
        const mergedLogins = run.created.filter((c) => c.recordId && c.recordId in s.merged).map((c) => c.login);
        if (mergedLogins.length) parts.push(`merged into identities that existed before the load: ${mergedLogins.join(", ")}`);
        if (early.length) parts.push(`re-enabled by someone else during the load: ${early.join(", ")}`);
        if (unreadable.length) parts.push(`not confirmed still off: ${unreadable.join(", ")}`);
        if (run.failed.length) parts.push(`rows refused by the POST: ${run.failed.map((f) => f.login).join(", ")} (resume loads them again)`);
        why = parts.join("; ") || "not every loaded identity settled";
      } else {
        const bad = await reenable(rt, state, statePath);
        if (bad.length) why = `workflows not confirmed enabled: ${bad.join(", ")}`;
      }
    } catch (e) {
      why = `the run failed after the disable: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (why) {
      rt.log(`!!! NOTICE WORKFLOWS ARE STILL OFF: ${why}`);
      atomicJson(resultsPath, res);
      return { exit: EXIT_INCOMPLETE, results: resultsPath, state: statePath, created: run.created.length, failed: run.failed.length, issues: [why], restore: `isc_nonemployee_load action=restore state_path=${statePath}` };
    }
    res.reenabledAt = run.reenabledAt = iso(rt.now());
    await afterChecks(rt, profile, run, t0, new Set(run.created.map((c) => c.identityId ?? "")));
    atomicJson(resultsPath, res);
    const issues: string[] = [];
    if (Array.isArray(run.otherChanges) && run.otherChanges.length) issues.push(`${run.otherChanges.length} other identities changed while their notices were off: review otherChanges in the results file`);
    else if (typeof run.otherChanges === "string") issues.push(`identity changes in the window ${run.otherChanges}`);
    if (run.failed.length) issues.push(`${run.failed.length} rows failed`);
    if (run.stopped) issues.push(`load stopped: ${run.stopped}: resume loads the rest`);
    rt.log(`created ${run.created.length}, failed ${run.failed.length} | results ${resultsPath}`);
    return { exit: issues.length ? EXIT_INCOMPLETE : EXIT_CLEAN, results: resultsPath, state: statePath, created: run.created.length, failed: run.failed.length, issues };
  } finally {
    lock.drop();
  }
}

// ---------------------------------------------------------------- restore

export interface RestoreOptions {
  statePath: string;
  force: boolean;
  capMinutes: number;
  adopt: Map<number, string | null>;
  release: Set<number>;
}

export async function restore(rt: Runtime, profile: LoadProfile, o: RestoreOptions): Promise<Outcome> {
  const state = readJson<State>(o.statePath);
  const res = existsSync(state.results) ? readJson<Results>(state.results) : null;
  const lock = new Lock(join(o.statePath, ".."), "restore");
  lock.take();
  try {
    if (!res) {
      if (!o.force) throw new RunError(`results file ${state.results} is missing: force_restore to re-enable without the settle gate`);
      state.forcedRestore = [...(state.forcedRestore ?? []), `${iso(rt.now())}: results missing`];
    }
    const issues: string[] = [];
    if (res && state.kind === "load") {
      // Holds the operator closes: adopt (the held record is this line's) or release (it is not).
      for (const c of res.created) {
        if (o.adopt.has(c.line) && c.checkByHand && !c.recordId) {
          const wanted = o.adopt.get(c.line);
          if (wanted && wanted !== c.checkByHand) {
            issues.push(`line ${c.line}: adopt names record ${wanted} but the held record is ${c.checkByHand}: refused`);
            continue;
          }
          c.recordId = c.checkByHand;
          c.uncertain = false;
          c.adoptedByHand = iso(rt.now());
          delete c.checkByHand;
          rt.log(`line ${c.line} ${c.login}: held record ${c.recordId} adopted`);
        } else if (o.release.has(c.line) && c.checkByHand && !c.recordId) {
          c.released = `${iso(rt.now())}: ${c.checkByHand}`;
          delete c.checkByHand;
          rt.log(`line ${c.line} ${c.login}: held record released; the line loads again on resume`);
        }
      }
      atomicJson(state.results, res);
      const run = res.runs.find((r) => r.state === o.statePath);
      const live = run ? run.created.filter((c) => !c.deleted) : [];
      const held = res.created.filter((c) => c.checkByHand && !c.recordId).map((c) => `line ${c.line} ${c.login}: record ${c.checkByHand} has this login but was not adopted: adopt or release the line`);
      issues.push(...held);
      if (run && !run.settledAt) {
        const mgrIds = await resolveManagers(rt, new Set(live.map((c) => c.manager ?? "")));
        const capS = Math.max(o.capMinutes * 60, live.length * 25);
        const s = await settle(rt, profile, res.sourceId, live, ts(run.t0iso), mgrIds, capS, o.force);
        run.notReady = s.notReady;
        run.merged = s.merged;
        atomicJson(state.results, res);
        if (s.complete) run.settledAt = iso(rt.now());
        else if (!o.force) {
          const lines = Object.entries(s.notReady).map(([k, v]) => `${k}: ${v}`);
          const mergedL = live.filter((c) => c.recordId && c.recordId in s.merged).map((c) => c.login);
          atomicJson(state.results, res);
          return {
            exit: EXIT_INCOMPLETE, results: state.results, state: o.statePath, created: live.length, failed: 0,
            issues: [...issues, ...lines, ...(mergedL.length ? [`merged into pre-existing identities: ${mergedL.join(", ")} (force_restore after a by-hand check)`] : [])],
            restore: `isc_nonemployee_load action=restore state_path=${o.statePath}`,
          };
        } else {
          state.forcedRestore = [...(state.forcedRestore ?? []), `${iso(rt.now())}: ${Object.keys(s.notReady).join(", ") || "merged"}`];
          issues.push(`forced: ${Object.keys(s.notReady).join(", ") || "merged identities"} overridden`);
        }
        atomicJson(state.results, res);
      }
    }
    if (res && state.kind === "delete" && state.deleteIds?.length) {
      // Deleted identities must be gone before the notices come back.
      const waiting: string[] = [];
      for (const c of res.created) {
        if (!c.deleted || !c.identityId || !state.deleteIds.includes(c.recordId ?? "")) continue;
        const { status } = await rt.api.get(`/v2025/identities/${c.identityId}`);
        if (status !== 404) waiting.push(`${c.login} (identity ${status})`);
      }
      if (waiting.length && !o.force) {
        return { exit: EXIT_INCOMPLETE, state: o.statePath, results: state.results, created: 0, failed: 0, issues: [`deleted records whose identity is still present: ${waiting.join(", ")}: wait, then run restore again`], restore: `isc_nonemployee_load action=restore state_path=${o.statePath}` };
      }
    }
    const bad = await reenable(rt, state, o.statePath);
    if (bad.length) {
      return { exit: EXIT_INCOMPLETE, state: o.statePath, results: state.results, created: 0, failed: 0, issues: [...issues, `workflows not confirmed enabled: ${bad.join(", ")}`], restore: `isc_nonemployee_load action=restore state_path=${o.statePath}` };
    }
    if (res) {
      res.reenabledAt = iso(rt.now());
      atomicJson(state.results, res);
    }
    return { exit: issues.length ? EXIT_INCOMPLETE : EXIT_CLEAN, state: o.statePath, results: state.results, created: 0, failed: 0, issues };
  } finally {
    lock.drop();
  }
}

// ---------------------------------------------------------------- rollback

export interface RollbackPlan {
  rows: { recordId: string; login: string; identityId: string | null; merged: boolean }[];
  gone: string[];
  held: string[];
  kept: string[];
  digest: string;
}

export async function rollbackPlan(rt: Runtime, resultsPath: string): Promise<RollbackPlan> {
  const res = readJson<Results>(resultsPath);
  const entries = liveCreated(res);
  const rejected = new Map<string, [string, string]>();
  if (!(await resolveUncertain(rt, res.sourceId, entries, rejected))) throw new RunError("the source could not be read: stopped");
  const mergedIds = new Set(res.runs.flatMap((r) => Object.keys(r.merged ?? {})));
  const rows: RollbackPlan["rows"] = [];
  const gone: string[] = [];
  const held: string[] = [];
  const kept: string[] = [];
  for (const c of entries) {
    if (!c.recordId) {
      if (c.checkByHand || rejected.has(c.login)) {
        kept.push(c.login);
        rt.log(`(check by hand) ${c.login}: a record has this login but was not adopted: kept`);
      } else rt.log(`(uncertain) ${c.login}: not in the source: nothing to delete`);
      continue;
    }
    const run = res.runs.find((r) => r.created.some((e) => e.recordId === c.recordId || e.login.toLowerCase() === c.login.toLowerCase()));
    const start = ts(run?.started ?? run?.t0iso ?? res.disabledAt);
    const { status, body } = await rt.api.get(`/v2025/non-employee-records/${c.recordId}`);
    if (status === 404) {
      gone.push(c.recordId);
      rt.log(`${c.recordId} ${c.login} gone`);
      continue;
    }
    if (status !== 200) {
      held.push(c.login);
      rt.log(`${c.recordId} ${c.login} READ FAILED (${status}): re-run the plan`);
      continue;
    }
    const r = asRecord(body);
    if (r.sourceId !== res.sourceId || String(r.accountName ?? "").toLowerCase() !== c.login.toLowerCase()) {
      kept.push(c.login);
      rt.log(`${c.recordId} ${c.login} MISMATCH: kept`);
      continue;
    }
    if (Number.isNaN(start)) {
      held.push(c.login);
      rt.log(`${c.recordId} ${c.login} RUN START UNKNOWN: the merged check is impossible: check by hand`);
      continue;
    }
    const i = await identityFor(rt, res.sourceId, c.recordId);
    if (!i) {
      held.push(c.login);
      rt.log(`${c.recordId} ${c.login} IDENTITY NOT FOUND: re-run once it resolves`);
      continue;
    }
    const merged = mergedIds.has(c.recordId) || preExisting(i, start);
    rows.push({ recordId: c.recordId, login: c.login, identityId: merged ? null : String(i.id), merged });
    rt.log(`${c.recordId} ${c.login} DELETE${c.resolvedByLogin ? " (found by login only)" : ""}${merged ? " (merged into a pre-existing identity: not waited on)" : ""}`);
  }
  const d = digest({ delete: rows.map((r) => r.recordId) });
  rt.log(`DELETE PLAN ${d} (${rows.length} records)${held.length ? `; re-run needed for ${held.join(", ")}` : ""}${kept.length ? `; kept for a by-hand check ${kept.join(", ")}` : ""}`);
  return { rows, gone, held, kept, digest: d };
}

export interface RollbackOptions {
  tenant: string;
  workDir: string;
  resultsPath: string;
  digest: string;
  suppress: { id: string; name: string }[];
  knownDisabled: Set<string>;
  capMinutes: number;
}

export async function rollback(rt: Runtime, profile: LoadProfile, o: RollbackOptions): Promise<Outcome> {
  const plan = await rollbackPlan(rt, o.resultsPath);
  if (plan.held.length) throw new RunError("rows above need a clean read first: re-run the plan: nothing deleted");
  if (o.digest !== plan.digest) throw new RunError(`plan ${o.digest} is not this delete plan (${plan.digest})`);
  const res = readJson<Results>(o.resultsPath);
  const markGone = (ids: string[], note: string) => {
    for (const c of res.created) if (c.recordId && ids.includes(c.recordId) && !c.deleted) c.deleted = `${iso(rt.now())}: ${note}`;
    atomicJson(o.resultsPath, res);
  };
  const lock = new Lock(o.workDir, "delete");
  lock.take();
  try {
    await preflight(rt, o.workDir, o.tenant, o.suppress, o.knownDisabled);
    if (!plan.rows.length) {
      markGone(plan.gone, "not found at the plan");
      return { exit: plan.kept.length ? EXIT_INCOMPLETE : EXIT_CLEAN, results: o.resultsPath, created: 0, failed: 0, issues: plan.kept.length ? [`kept for a by-hand check: ${plan.kept.join(", ")}`] : ["nothing to delete"] };
    }
    const { state, statePath } = await newState(rt, o.workDir, o.tenant, "delete", o.resultsPath, o.suppress);
    state.deleteIds = plan.rows.map((r) => r.recordId);
    atomicJson(statePath, state);
    let t0: Record<string, unknown[]> | null = null;
    try {
      t0 = await snapshot(rt, profile.watch);
    } catch (e) {
      unlinkSync(statePath);
      throw new RunError(`T0 snapshot failed (${e instanceof Error ? e.message : String(e)}): nothing disabled`);
    }
    atomicJson(statePath.replace("-STATE-", "-T0-"), t0);
    res.rollbacks = [...(res.rollbacks ?? []), { at: iso(rt.now()), deleted: [], state: statePath }];
    atomicJson(o.resultsPath, res);
    rt.log(`STATE ${statePath}`);
    let why: string | null = null;
    const deleted: string[] = [];
    const uncertain: string[] = [];
    try {
      await suppress(rt, state, statePath);
      markGone(plan.gone, "not found at the plan");
      for (const r of plan.rows) {
        const c = res.created.find((e) => e.recordId === r.recordId)!;
        c.identityId = r.identityId ?? c.identityId;
        c.deleted = `${iso(rt.now())}: sent`;
        atomicJson(o.resultsPath, res);
        const { status } = await rt.write("DELETE", `/v2025/non-employee-records/${r.recordId}`, undefined);
        let gone = status === 204 || status === 200 || status === 404;
        if (!gone && (status === 0 || status >= 500)) {
          for (let k = 0; k < 6 && !gone; k++) {
            await rt.sleep(10_000);
            gone = (await rt.api.get(`/v2025/non-employee-records/${r.recordId}`)).status === 404;
          }
        }
        if (gone) {
          deleted.push(r.recordId);
          rt.log(`${r.recordId} ${r.login} deleted`);
        } else if (status === 0 || status >= 500) {
          uncertain.push(r.login);
          rt.log(`${r.recordId} ${r.login} UNCERTAIN (${status}): restore decides`);
        } else {
          delete c.deleted;
          atomicJson(o.resultsPath, res);
          why = `DELETE ${r.recordId} refused (${status}): stopped at the first refusal`;
          rt.log(`!! ${why}`);
          break;
        }
      }
      res.rollbacks[res.rollbacks.length - 1].deleted = deleted;
      atomicJson(o.resultsPath, res);
      // Wait for the deleted identities to be gone (merged ones are not waited on).
      const capMs = Math.max(o.capMinutes * 60, deleted.length * 25) * 1000;
      const tEnd = rt.now() + capMs;
      const waitOn = plan.rows.filter((r) => deleted.includes(r.recordId) && r.identityId);
      let present = waitOn;
      while (present.length && rt.now() < tEnd) {
        const still: typeof waitOn = [];
        for (const r of present) if ((await rt.api.get(`/v2025/identities/${r.identityId}`)).status !== 404) still.push(r);
        present = still;
        if (present.length) {
          rt.log(`identities still present ${present.length}/${waitOn.length}`);
          await rt.sleep(20_000);
        }
      }
      if (present.length) why = [why, `identities still present for ${present.map((r) => r.login).join(", ")}`].filter(Boolean).join("; ");
      if (uncertain.length) why = [why, `deletes uncertain for ${uncertain.join(", ")}`].filter(Boolean).join("; ");
      if (!why) {
        const bad = await reenable(rt, state, statePath);
        if (bad.length) why = `workflows not confirmed enabled: ${bad.join(", ")}`;
      }
    } catch (e) {
      why = `the rollback failed after the disable: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (why) {
      rt.log(`!!! NOTICE WORKFLOWS ARE STILL OFF: ${why}`);
      return { exit: EXIT_INCOMPLETE, results: o.resultsPath, state: statePath, created: deleted.length, failed: 0, issues: [why], restore: `isc_nonemployee_load action=restore state_path=${statePath}` };
    }
    const run: Run = { started: iso(rt.now()), t0iso: iso(rt.now()), plan: o.digest, state: statePath, t0: "", planned: [], created: [], failed: [] };
    await afterChecks(rt, profile, run, t0, new Set(plan.rows.map((r) => r.identityId ?? "")));
    const issues: string[] = [];
    if (Array.isArray(run.otherChanges) && run.otherChanges.length) issues.push(`${run.otherChanges.length} other identities changed while their notices were off`);
    if (plan.kept.length) issues.push(`kept for a by-hand check: ${plan.kept.join(", ")}`);
    return { exit: issues.length ? EXIT_INCOMPLETE : EXIT_CLEAN, results: o.resultsPath, state: statePath, created: deleted.length, failed: 0, issues };
  } finally {
    lock.drop();
  }
}

export { ENDED };
