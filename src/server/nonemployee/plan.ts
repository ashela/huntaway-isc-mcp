// The dry run: read the export, validate every row against the profile and
// the tenant, resolve managers and reference codes, reserve a login per row,
// and build the record each loadable row would POST. Nothing here writes.
// The plan's digest (tenant, records, suppressed workflow ids, file sha) is
// the human checkpoint: an apply must quote it.

import type { LoadProfile } from "./profile.js";
import {
  ATOM_RX, ENDED, NAME_RX, addDays, addrForm, clean, compatChars, dateOrder, dayFromIso, daysBetween, dayToIso, expectedState,
  foldable, parseDate, personKey, uidForm, type DateOrder, type Day,
} from "./text.js";
import { asList, asRecord } from "../util.js";

export interface Api {
  get(path: string): Promise<{ status: number; body: unknown }>;
  /** POST /v2025/search on identities; returns rows. Throws on a failed read. */
  search(query: string, fields?: string[], limit?: number): Promise<Record<string, unknown>[]>;
}

export class PlanError extends Error {}

export interface Row {
  line: number;
  cells: Record<string, string>;
}

/** Tab-separated, unquoted, header checked against the columns the profile names. */
export function readRows(text: string, profile: LoadProfile): Row[] {
  if (text.includes("�")) throw new PlanError("the file holds U+FFFD replacement characters (an accent was lost before it reached this file): stopped");
  const lines = text.split(/\r?\n/);
  const header = (lines[0] ?? "").split("\t").map((h) => h.replace(/^﻿/, "").trim());
  if (!header.length || !header[0]) throw new PlanError("empty file");
  const needed = new Set<string>([...Object.values(profile.columns).filter((c): c is string => Boolean(c)), ...Object.values(profile.data).map((d) => d.column)]);
  const missing = [...needed].filter((c) => !header.includes(c));
  if (missing.length) throw new PlanError(`header lacks the columns the profile names: ${missing.join(", ")}: stopped`);
  if (new Set(header).size !== header.length) throw new PlanError("header has a repeated column: stopped");
  const rows: Row[] = [];
  lines.forEach((raw, i) => {
    if (i === 0 || !raw.trim()) return;
    const cells = raw.split("\t");
    if (cells.length !== header.length) throw new PlanError(`line ${i + 1} has ${cells.length} fields, the header has ${header.length}: stopped`);
    const row: Record<string, string> = {};
    header.forEach((h, k) => {
      row[h] = cells[k];
    });
    rows.push({ line: i + 1, cells: row });
  });
  return rows;
}

export interface Reference {
  sourceId: string;
  /** Existing records of the source. */
  records: Record<string, unknown>[];
  /** REF source name -> set of codes. */
  refs: Record<string, Set<string>>;
  /** Form element key -> allowed option values. */
  formOptions: Record<string, string[]>;
  /** Workflow name -> {id, enabled} for the suppress list. */
  suppress: { id: string; name: string; enabled: boolean; definition: unknown }[];
  formId?: string;
}

async function page(api: Api, path: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 250) {
    const { status, body } = await api.get(`${path}${path.includes("?") ? "&" : "?"}limit=250&offset=${offset}`);
    if (status !== 200) throw new PlanError(`read ${path} failed (HTTP ${status})`);
    const rows = asList(body);
    out.push(...rows);
    if (rows.length < 250) return out;
  }
}

export const recordsFilter = (sourceId: string) => `/v2025/non-employee-records?filters=${encodeURIComponent(`sourceId eq "${sourceId}"`)}`;

/** Everything on the tenant the plan checks against. */
export async function reference(api: Api, profile: LoadProfile): Promise<Reference> {
  const { status, body } = await api.get("/v2025/non-employee-sources?limit=250");
  if (status !== 200) throw new PlanError(`non-employee sources could not be read (HTTP ${status})`);
  const sources = asList(body);
  const byName = new Map(sources.map((s) => [String(s.name), String(s.sourceId ?? s.id)]));
  const sourceId = byName.get(profile.source);
  if (!sourceId) throw new PlanError(`non-employee source ${JSON.stringify(profile.source)} not found; available: ${[...byName.keys()].join(", ")}`);
  const refs: Record<string, Set<string>> = {};
  for (const field of Object.values(profile.data)) {
    if (!field.ref || refs[field.ref]) continue;
    const rid = byName.get(field.ref);
    if (!rid) throw new PlanError(`reference source ${JSON.stringify(field.ref)} not found`);
    refs[field.ref] = new Set((await page(api, recordsFilter(rid))).map((r) => String(r.accountName ?? "")));
    if (!refs[field.ref].size) throw new PlanError(`${field.ref} has no records: stopped`);
  }
  const records = await page(api, recordsFilter(sourceId));
  const wfRes = await api.get("/v2025/workflows?limit=250");
  if (wfRes.status !== 200) throw new PlanError(`workflows could not be read (HTTP ${wfRes.status})`);
  const workflows = asList(wfRes.body);
  const formOptions: Record<string, string[]> = {};
  let formId: string | undefined;
  if (profile.writerWorkflow) {
    const writer = workflows.filter((w) => w.name === profile.writerWorkflow);
    if (writer.length !== 1) throw new PlanError(`${profile.writerWorkflow}: ${writer.length} found: stopped`);
    const m = /formDefinitionId\s*==\s*'([0-9a-f-]{36})'/.exec(JSON.stringify(writer[0].trigger ?? {}));
    if (!m) throw new PlanError("the writer workflow's trigger names no form: stopped");
    formId = m[1];
    const form = await api.get(`/v2025/form-definitions/${formId}`);
    if (form.status !== 200) throw new PlanError(`form ${formId} could not be read (HTTP ${form.status})`);
    const walk = (els: unknown) => {
      for (const e of asList(els)) {
        const cfg = asRecord(e.config);
        const ds = asRecord(cfg.dataSource);
        if (ds.dataSourceType === "STATIC") formOptions[String(e.key)] = asList(asRecord(ds.config).options).map((o) => String(o.value));
        walk(cfg.formElements);
        walk(e.formElements);
      }
    };
    walk(asRecord(form.body).formElements);
    for (const [key, field] of Object.entries(profile.data)) {
      if (field.formOption && !formOptions[field.formOption]?.length) throw new PlanError(`form has no static option list ${field.formOption} (for ${key}): stopped`);
    }
  }
  const suppress = profile.suppress.map((n) => {
    const hit = workflows.filter((w) => w.name === n);
    if (hit.length !== 1) throw new PlanError(`suppress workflow ${JSON.stringify(n)} matches ${hit.length} workflows: stopped`);
    return { id: String(hit[0].id), name: n, enabled: hit[0].enabled === true, definition: hit[0].definition };
  });
  return { sourceId, records, refs, formOptions, suppress, formId };
}

export interface PlanOptions {
  dateOrder?: DateOrder;
  /** data key -> { file value -> accepted value }. */
  map: Record<string, Record<string, string>>;
  /** Lines allowed to duplicate an existing record's name. */
  allowDup: Set<number>;
  /** line -> login the operator accepts for a same-name-in-file or earlier-run duplicate. */
  allowDupLogin: Map<number, string>;
  allowPreLeaver: boolean;
  allowAdInactive: Set<number>;
  /** Lines allowed a needsAllow value (e.g. "Other"). */
  allowValue: Set<number>;
  showManagerNames: boolean;
  /** Today in the operator's calendar. */
  today: Day;
  /** Today as the lifecycle transform sees it. */
  transformToday: Day;
  /** Lines already created by the run being resumed. */
  skipLines: Set<number>;
  /** Logins created by earlier runs of this loader and not deleted. */
  loaderLogins: Set<string>;
}

export interface PlanRow {
  line: number;
  login: string | null;
  state: string | null;
  managerPath: string;
  errors: string[];
  notes: string[];
  record: Record<string, unknown> | null;
  done?: boolean;
}

const q = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;

/** The writer's Login Check: identity names anywhere in the tenant, lower-cased. */
async function loginTaken(api: Api, cands: string[]): Promise<Set<string>> {
  const rows = await api.search(cands.map((c) => `name:${q(c)}`).join(" OR "), ["name"], 50);
  return new Set(rows.map((x) => String(x.name ?? "").toLowerCase()));
}

export async function planRows(api: Api, profile: LoadProfile, rows: Row[], ref: Reference, opt: PlanOptions): Promise<PlanRow[]> {
  const nulls = profile.nulls;
  const nameNulls = [...nulls, "NONE"];
  const cols = profile.columns;
  const orders: Record<string, DateOrder> = {};
  for (const col of [cols.startDate, cols.endDate]) {
    const r = dateOrder(rows.map((x) => clean(x.cells[col], nulls)), opt.dateOrder);
    if (r.error) throw new PlanError(`${col}: ${r.error}: stopped`);
    orders[col] = r.order!;
  }
  const names = new Set(ref.records.map((r) => String(r.accountName ?? "").toLowerCase()));
  const uids = new Set(ref.records.map((r) => profile.uidPrefix + uidForm(String(r.accountName ?? ""))));
  const existing = new Map<string, Set<string>>();
  const byLast = new Map<string, Set<string>>();
  for (const r of ref.records) {
    const last = String(r.lastName ?? "");
    for (const fn of [String(r.firstName ?? ""), String(asRecord(r.data).preferredName ?? "")]) {
      if (!fn) continue;
      const k = personKey(fn, last);
      if (!existing.has(k)) existing.set(k, new Set());
      existing.get(k)!.add(String(r.accountName ?? ""));
      const lk = k.split("|")[1];
      if (!byLast.has(lk)) byLast.set(lk, new Set());
      byLast.get(lk)!.add(`${k.split("|")[0]}=${String(r.accountName ?? "")}`);
    }
  }
  let fallbackOk = false;
  if (profile.manager.fallbackUid) {
    const svc = await api.search(`attributes.uid.exact:${q(profile.manager.fallbackUid)}`, ["attributes.uid", "attributes.cloudLifecycleState"], 5);
    fallbackOk = svc.length === 1 && asRecord(svc[0].attributes).cloudLifecycleState === "active";
  }
  const mgrCache = new Map<string, { hits: Record<string, unknown>[]; path: string }>();
  const planned = new Set<string>();
  const seenAll = new Map<string, number>();
  const wouldTake = new Set<string>();
  const wouldUids = new Set<string>();
  const out: PlanRow[] = [];
  const earliest = dayFromIso(profile.lifecycle.earliestStart)!;
  const latest = addDays(opt.today, Math.round(profile.lifecycle.maxYearsAhead * 366));
  const usedMaps = new Set<string>();

  for (const row of rows) {
    const { line } = row;
    const errs: string[] = [];
    const notes: string[] = [];
    if (opt.skipLines.has(line)) {
      out.push({ line, login: null, state: null, managerPath: "", errors: ["created by the earlier run"], notes: [], record: null, done: true });
      continue;
    }
    const c = (col: string | undefined, nn = nulls) => (col ? clean(row.cells[col], nn) : "");
    const first = c(cols.firstName, nameNulls);
    const last = c(cols.lastName, nameNulls);
    let pref = c(cols.preferredName, nameNulls);
    // The export may append the preferred name to the end date ("10/29/2027 Nick").
    const endCell = c(cols.endDate);
    const mm = endCell ? /^(\S+)(?:\s+(.+))?$/.exec(endCell) : null;
    const endS = mm ? mm[1] : "";
    let tail = (mm?.[2] ?? "").split(/\s+/).filter((t) => t && !nameNulls.includes(t.toUpperCase()));
    if (tail.some((t) => ["TBC", "TBA", "EXTENDED", "ONGOING", "EXTN", "EXT", "PERMANENT"].includes(t.toUpperCase().replace(/\.$/, "")))) {
      errs.push(`end-date column carries "${tail.join(" ")}" after the date: a status word, not a name`);
      tail = [];
    }
    if (tail.length) {
      const t = tail.join(" ");
      if (tail.length > 1 || /[\d:]/.test(t)) errs.push(`end-date column carries "${t}" after the date (expected one name or a null token)`);
      else if (pref && pref !== t) errs.push(`preferred name in two places: "${pref}" / "${t}"`);
      else {
        pref = pref || t;
        notes.push("preferred name from the end-date column");
      }
    }
    for (const [label, v, need] of [["firstName", first, true], ["lastName", last, true], ["preferred name", pref, false]] as const) {
      if (need && !v) errs.push(`${label} is required`);
      else if (v && !NAME_RX.test(v)) errs.push(`${label} "${v}" has characters a name cannot have`);
      else if (v && compatChars(v).length) errs.push(`${label} "${v}" holds ${compatChars(v).map((ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`).join(" ")} (superscript, circled, fullwidth, ligature or similar): retype them as plain letters`);
      else if (v && !foldable(v)) errs.push(`${label} "${v}" has characters with no plain-Latin letter form (a look-alike?)`);
    }
    const start = parseDate(c(cols.startDate), orders[cols.startDate]);
    const end = parseDate(endS, orders[cols.endDate]);
    let state: string | null = null;
    if (!start || !end) errs.push(`dates unreadable: "${c(cols.startDate)}" "${endS}"`);
    else if (daysBetween(start, end) > 0) errs.push(`start ${dayToIso(start)} after end ${dayToIso(end)}`);
    else if (daysBetween(start, earliest) < 0 || daysBetween(end, latest) > 0) errs.push(`dates out of range: ${dayToIso(start)}..${dayToIso(end)}`);
    else {
      state = expectedState(start, end, opt.today, profile.lifecycle);
      const alt = expectedState(start, end, opt.transformToday, profile.lifecycle);
      if ((state === "preLeaver" || alt === "preLeaver") && !opt.allowPreLeaver) {
        errs.push(`ends within ${profile.lifecycle.preLeaverDays} days: lands in preLeaver (leaver reminders mail the manager): needs allow_preleaver`);
      }
    }
    // data fields
    const data: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(profile.data)) {
      let v = c(field.column);
      if (field.upper) v = v.toUpperCase();
      const map = opt.map[key];
      if (map && v in map) {
        usedMaps.add(`${key}=${v}`);
        v = map[v];
      }
      if (!v && field.blank !== undefined) v = field.blank;
      if (field.numeric && /^[0-9]+(?:\.0+)?$/.test(v)) v = String(Math.trunc(Number(v)));
      const isBlankDefault = field.blank !== undefined && v === field.blank;
      if (field.ref && !isBlankDefault && !ref.refs[field.ref]?.has(v)) errs.push(`${field.column} "${v}" is not a ${field.ref} record`);
      if (field.formOption) {
        const opts = ref.formOptions[field.formOption] ?? [];
        if (!opts.includes(v)) errs.push(`${field.column} "${v}" is not a form option (closest: ${closest(v, opts).join(", ")})`);
      }
      if (field.values && !field.values.includes(v)) errs.push(`${field.column} "${v}" is not one of ${field.values.join(", ")} (map legacy codes with map)`);
      if (field.needsAllow !== undefined && v === field.needsAllow && !opt.allowValue.has(line)) {
        errs.push(`${field.column} "${v}" needs allow_value ${line}`);
      }
      data[key] = v;
    }
    // AD state
    let ad = "";
    if (cols.adActive) {
      ad = c(cols.adActive);
      if (!profile.adAllValues.includes(ad)) errs.push(`${cols.adActive} "${ad}" is not one of ${profile.adAllValues.join(" / ")}`);
      else if (!profile.adActiveValues.includes(ad) && state && !ENDED.has(state) && !opt.allowAdInactive.has(line)) {
        errs.push(`${cols.adActive} "${ad}" on a live row: needs allow_ad_inactive ${line}`);
      }
    }
    // manager
    let mgr: string | null = null;
    let path = "";
    if (cols.managerKey || cols.managerName) {
      let key = c(cols.managerKey);
      if (!key && cols.managerName) {
        const num = c(cols.managerName).match(/\b[0-9]+\b/g) ?? [];
        key = num.length === 1 ? num[0] : "";
      }
      if (!key) errs.push("no manager key (the manager column, or one number in the manager name)");
      else {
        if (!mgrCache.has(key)) {
          const fields = ["id", "displayName", "attributes.uid", "attributes.cloudLifecycleState", `attributes.${profile.manager.keyAttribute}`];
          let hits: Record<string, unknown>[];
          let p: string;
          if (/^[0-9]+$/.test(key)) {
            hits = await api.search(`attributes.uid.exact:${q(key)}`, fields, 5);
            p = "uid";
          } else {
            hits = await api.search(`attributes.${profile.manager.keyAttribute}.exact:${q(key)}`, fields, 5);
            p = profile.manager.keyAttribute;
            const sp = profile.manager.stripPrefix;
            if (!hits.length && sp && key.toLowerCase().startsWith(sp.toLowerCase())) {
              hits = await api.search(`attributes.uid.exact:${q(key.slice(sp.length))}`, fields, 5);
              p = `${sp} stripped to uid`;
            }
          }
          mgrCache.set(key, { hits, path: p });
        }
        const { hits, path: p } = mgrCache.get(key)!;
        path = p;
        if (hits.length > 1) errs.push(`manager "${key}" resolves to ${hits.length} identities`);
        else {
          const h = hits[0];
          const mstate = h ? String(asRecord(h.attributes).cloudLifecycleState ?? "") : "not found";
          if (h) notes.push(`manager state ${mstate}${opt.showManagerNames ? `, name "${String(h.displayName ?? "")}"` : ""}`);
          const muid = h ? String(asRecord(h.attributes).uid ?? "") : "";
          if (h && profile.manager.okStates.includes(mstate)) {
            if (!muid) errs.push(`manager "${key}" has no uid (the record stores the uid)`);
            else {
              mgr = muid;
              if (mstate !== profile.manager.okStates[0]) notes.push(`manager "${key}" is ${mstate}`);
            }
          } else if (state && ENDED.has(state) && (!h || profile.manager.goneStates.includes(mstate))) {
            if (profile.manager.fallbackUid && fallbackOk) {
              mgr = profile.manager.fallbackUid;
              notes.push(`${h ? `manager "${key}" is ${mstate}` : `manager key "${key}" matches NO identity (check for a typo)`}: fallback manager instead`);
            } else errs.push(`manager "${key}" is ${mstate} and no active fallback manager is configured`);
          } else if (state && ENDED.has(state)) errs.push(`manager "${key}" is ${mstate} (an ended row takes ${profile.manager.okStates.join("/")}, or a departed manager takes the fallback)`);
          else errs.push(`manager "${key}" is ${mstate} (live rows need ${profile.manager.okStates.join(" or ")})`);
        }
      }
    }
    // duplicates
    const keys = new Set([personKey(first, last), ...(pref ? [personKey(pref, last)] : [])]);
    const needLogin: string[] = [];
    let hitSrc: string[] = [];
    if (first && last) {
      const hitFile = [...new Set([...keys].filter((k) => seenAll.has(k)).map((k) => seenAll.get(k)!))].sort((a, b) => a - b);
      hitSrc = [...new Set([...keys].flatMap((k) => [...(existing.get(k) ?? [])]))].sort();
      if (hitFile.length) needLogin.push(`same name as line ${hitFile.join(", ")} of this file`);
      const ours = hitSrc.filter((a) => opt.loaderLogins.has(a.toLowerCase()));
      if (ours.length) needLogin.push(`matches ${ours.join(", ")} that an earlier run of this loader created`);
      else if (hitSrc.length && !opt.allowDup.has(line)) errs.push(`records already exist for this name (${hitSrc.join(", ")}); allow_dup ${line} if a different person`);
      else if (hitSrc.length) notes.push(`matches existing records ${hitSrc.join(", ")} (allowed by allow_dup)`);
      if (!hitFile.length && !hitSrc.length) {
        const firsts = [...keys].map((k) => k.split("|")[0]);
        const lk = personKey(first, last).split("|")[1];
        const alike = (f: string) => firsts.some((g) => g && f && (f.slice(0, 3) === g.slice(0, 3) || f.startsWith(g) || g.startsWith(f)));
        const near = [...(byLast.get(lk) ?? [])].filter((x) => alike(x.split("=")[0])).map((x) => x.split("=")[1]).sort();
        if (near.length) notes.push(`possibly the same person as ${near.join(", ")}: same last name, similar first name: check`);
      }
      for (const k of keys) if (!seenAll.has(k)) seenAll.set(k, line);
    }
    // login
    let login: string | null = null;
    if (first && last && !errs.length) {
      const lead = (profile.login.lead === "preferred" && pref) || first;
      const base = `${lead.replace(/\s+/g, "")}.${last.replace(/\s+/g, "")}`;
      const cands = [base, ...Array.from({ length: profile.login.suffixes }, (_, n) => `${base}${n + 1}`)];
      const taken = await loginTaken(api, cands);
      const uidRows = await api.search(cands.map((cd) => `attributes.uid.exact:${q(profile.uidPrefix + uidForm(cd))}`).join(" OR "), ["attributes.uid"], 50);
      const uidTaken = new Set(uidRows.map((x) => String(asRecord(x.attributes).uid ?? "").toLowerCase()));
      for (const cand of cands) {
        const u = profile.uidPrefix + uidForm(cand);
        if (!taken.has(cand.toLowerCase()) && !names.has(cand.toLowerCase()) && !planned.has(cand.toLowerCase()) && !wouldTake.has(cand.toLowerCase()) &&
            !uids.has(u) && !wouldUids.has(u) && !uidTaken.has(u)) {
          login = cand;
          break;
        }
      }
      const wanted = opt.allowDupLogin.get(line);
      if (!login) errs.push(`no free login among ${base} and ${base}1..${profile.login.suffixes}`);
      else if (!ATOM_RX.test(addrForm(login))) {
        errs.push(`login "${login}" gives an invalid address local part "${addrForm(login)}"`);
        login = null;
      } else if (wanted && wanted.toLowerCase() !== login.toLowerCase()) {
        errs.push(`${needLogin.length ? needLogin.join("; ") + "; " : ""}allow_dup ${line}=${wanted}, but the planned login is ${login}: re-check the row`);
        wouldTake.add(login.toLowerCase());
        wouldUids.add(profile.uidPrefix + uidForm(login));
        login = null;
      } else if (needLogin.length && wanted) {
        notes.push(`${needLogin.join("; ")}: a different person, accepted by allow_dup ${line}=${login}`);
        if (hitSrc.length) notes.push(`matches existing records ${hitSrc.join(", ")}`);
      } else if (needLogin.length) {
        errs.push(`${needLogin.join("; ")}: the same person twice? If a different person, accept the new login with allow_dup ${line}=${login}`);
        wouldTake.add(login.toLowerCase());
        wouldUids.add(profile.uidPrefix + uidForm(login));
        login = null;
      }
    } else if (needLogin.length) {
      errs.push(`${needLogin.join("; ")} (once the other errors are fixed, the dry run names the login allow_dup ${line}=<login> accepts)`);
    }
    let record: Record<string, unknown> | null = null;
    if (!errs.length && login && start && end) {
      planned.add(login.toLowerCase());
      uids.add(profile.uidPrefix + uidForm(login));
      const d: Record<string, unknown> = { ...data, ...profile.constants };
      if (pref) d.preferredName = pref;
      record = {
        sourceId: ref.sourceId,
        accountName: login,
        firstName: first,
        lastName: last,
        ...(profile.phone ? { phone: profile.phone } : {}),
        email: `${profile.email.prefix}${addrForm(login)}@${profile.email.domain}`,
        ...(mgr ? { manager: mgr } : {}),
        startDate: `${dayToIso(start)}T12:00:00Z`,
        endDate: `${dayToIso(end)}T12:00:00Z`,
        data: d,
      };
    }
    out.push({ line, login, state, managerPath: path, errors: errs, notes, record });
  }
  const unused = Object.entries(opt.map).flatMap(([k, m]) => Object.keys(m).map((v) => `${k}=${v}`)).filter((x) => !usedMaps.has(x));
  if (unused.length) out.push({ line: 0, login: null, state: null, managerPath: "", errors: [], notes: [`map entries that matched no row: ${unused.join(", ")}`], record: null, done: true });
  return out;
}

/** Up to three options nearest to v by a simple edit distance, for a SKIP message. */
export function closest(v: string, opts: string[]): string[] {
  const d = (a: string, b: string) => {
    const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1));
    }
    return m[a.length][b.length];
  };
  return [...opts].map((o) => [o, d(v, o)] as const).sort((a, b) => a[1] - b[1]).slice(0, 3).filter((x) => x[1] <= Math.max(3, v.length / 2)).map((x) => x[0]);
}

/** What an apply must quote. Same inputs, same digest; any change to the file or the options gives a new one. */
export function planDigest(tenantKey: string, plan: PlanRow[], suppressIds: string[], fileSha: string): { digest: string; count: number } {
  const records = plan.filter((p) => p.record).map((p) => p.record);
  return { digest: digestOf({ tenant: tenantKey, records, suppress: suppressIds, file: fileSha }), count: records.length };
}

import { digest as digestOf } from "./text.js";
