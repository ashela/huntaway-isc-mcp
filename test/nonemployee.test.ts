// leak-gate: fixtures
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProfile, type LoadProfile } from "../src/server/nonemployee/profile.js";
import { planDigest, planRows, readRows, reference, type Api } from "../src/server/nonemployee/plan.js";
import { apply, restore, rollback, rollbackPlan, readJson, type Results, type Runtime, type State } from "../src/server/nonemployee/run.js";
import { addrForm, compatChars, dateOrder, dayFromIso, expectedState, foldable, nameFold, parseDate, personKey, quietOverlap, uidForm } from "../src/server/nonemployee/text.js";

const PROFILE = JSON.parse(readFileSync(join(__dirname, "..", "resources", "examples", "nonemployee-profile.example.json"), "utf8"));

function profile(over: Record<string, unknown> = {}): LoadProfile {
  const p = { ...PROFILE, ...over, settle: { ...PROFILE.settle, stableSeconds: 10, settleSeconds: 5, ...(over.settle as object ?? {}) }, quietWindows: [] };
  const r = parseProfile(JSON.stringify(p));
  if (!r.profile) throw new Error(r.error);
  return r.profile;
}

const HEADER = "firstName\tlastName\tmobilePhone\temail\tManagerEmployeeID\tManagerName\temployeeStartDate\temployeeEndDate\tPreferredName\tsystemAccessRequired\tDivisionCode\tDivisionName\tBusinessUnitCode\tBusinessUnitName\tVendor\tSiteCode\tSiteName\tLocationCode\tLocationName\tHoursPerWeek\tJobTitle\tAD Account Active";

function row(o: Partial<Record<string, string>>): string {
  const d: Record<string, string> = {
    firstName: "Ann", lastName: "Lee", mobilePhone: "", email: "", ManagerEmployeeID: "E100", ManagerName: "Mia Boss", employeeStartDate: "2026-01-05",
    employeeEndDate: "2027-06-30", PreferredName: "", systemAccessRequired: "AD", DivisionCode: "DIV1", DivisionName: "", BusinessUnitCode: "BU1",
    BusinessUnitName: "", Vendor: "Acme", SiteCode: "S1", SiteName: "", LocationCode: "", LocationName: "", HoursPerWeek: "40", JobTitle: "Analyst", "AD Account Active": "Yes", ...o,
  };
  return HEADER.split("\t").map((h) => d[h] ?? "").join("\t");
}

/** An in-memory tenant: non-employee sources with records, identities, workflows, a search index. */
class FakeTenant {
  records = new Map<string, Record<string, unknown>>();
  identities = new Map<string, Record<string, unknown>>();
  workflows = new Map<string, Record<string, unknown>>();
  writes: string[] = [];
  nextId = 1;
  clockMs = Date.parse("2026-03-10T02:00:00Z");
  /** After a record is created, its identity appears on the next read. */
  identityDelayReads = 0;
  postStatus = 201;
  sources = { "Vendor Staff": "src-con", "REF-Division": "src-div", "REF-BusinessUnit": "src-bu", "REF-Site": "src-site", "REF-Location": "src-loc" };

  constructor() {
    for (const [src, codes] of [["src-div", ["DIV1", "DIV2"]], ["src-bu", ["BU1"]], ["src-site", ["S1"]], ["src-loc", ["L1"]]] as const) {
      for (const c of codes) this.addRecord({ sourceId: src, accountName: c, firstName: c, lastName: c });
    }
    this.identities.set("mgr1", { id: "mgr1", name: "mia.boss", displayName: "Mia Boss", created: "2025-01-01T00:00:00Z", attributes: { uid: "mboss", cloudLifecycleState: "active", identificationNumber: "E100", lastname: "Boss", identityType: "EMPLOYEE" } });
    this.identities.set("svc1", { id: "svc1", name: "svc", created: "2025-01-01T00:00:00Z", attributes: { uid: "svc_identity_specialist", cloudLifecycleState: "active", lastname: "Svc" } });
    this.identities.set("gone1", { id: "gone1", name: "old.boss", created: "2025-01-01T00:00:00Z", attributes: { uid: "oboss", cloudLifecycleState: "terminated", identificationNumber: "E900", lastname: "Old" } });
    this.addRecord({ sourceId: "src-con", accountName: "Bob.Dup", firstName: "Bob", lastName: "Dup" });
    this.tick(); // the existing record has its identity before any run starts
    let n = 0;
    for (const name of PROFILE.suppress) this.workflows.set(`wf${++n}`, { id: `wf${n}`, name, enabled: true, definition: { steps: { a: n } } });
    this.workflows.set("writer", { id: "writer", name: "Vendor Staff Onboarding Writer", enabled: true, trigger: { attributes: { filter: "$.formDefinitionId == 'f1f1f1f1-1111-2222-3333-444444444444'" } }, definition: {} });
  }

  addRecord(r: Record<string, unknown>): Record<string, unknown> {
    const id = `rec${this.nextId++}`;
    const rec = { id, created: new Date(this.clockMs).toISOString(), data: {}, ...r };
    this.records.set(id, rec);
    return rec;
  }

  /** Called by the runtime clock: identities materialise for records as time passes. */
  tick(): void {
    for (const r of this.records.values()) {
      if (r.sourceId !== "src-con" || [...this.identities.values()].some((i) => i.recordId === r.id)) continue;
      if (this.identityDelayReads-- > 0) continue;
      const login = String(r.accountName);
      const iid = `id-${login.toLowerCase()}`;
      this.identities.set(iid, {
        id: iid, name: login, recordId: r.id, created: new Date(this.clockMs).toISOString(), managerRef: { id: r.manager === "mboss" ? "mgr1" : r.manager === "svc_identity_specialist" ? "svc1" : null },
        processingState: "OK", attributes: { uid: uidForm(login), cloudLifecycleState: r.endDate && String(r.endDate) < "2026-03" ? "terminated" : "active", identityType: "CONTRACTOR", lastname: r.lastName, businessUnitCode: (r.data as Record<string, unknown>).businessUnitCode },
      });
    }
  }

  async get(path: string): Promise<{ status: number; body: unknown }> {
    const u = new URL(`https://t${path}`);
    const p = u.pathname;
    const filters = u.searchParams.get("filters") ?? "";
    const limit = Number(u.searchParams.get("limit") ?? 250);
    const offset = Number(u.searchParams.get("offset") ?? 0);
    const pageOf = (rows: unknown[]) => ({ status: 200, body: rows.slice(offset, offset + limit) });
    if (p === "/v2025/non-employee-sources") return { status: 200, body: Object.entries(this.sources).map(([name, sourceId]) => ({ name, sourceId })) };
    if (p === "/v2025/non-employee-records") {
      const m = /sourceId eq "([^"]+)"/.exec(filters);
      return pageOf([...this.records.values()].filter((r) => !m || r.sourceId === m[1]));
    }
    const rec = /^\/v2025\/non-employee-records\/([^/]+)$/.exec(p);
    if (rec) return this.records.has(rec[1]) ? { status: 200, body: this.records.get(rec[1]) } : { status: 404, body: {} };
    if (p === "/v2025/workflows") return pageOf([...this.workflows.values()]);
    const wf = /^\/v2025\/workflows\/([^/]+)$/.exec(p);
    if (wf) return this.workflows.has(wf[1]) ? { status: 200, body: this.workflows.get(wf[1]) } : { status: 404, body: {} };
    if (p.startsWith("/v2025/form-definitions/")) {
      return { status: 200, body: { formElements: [{ key: "vendor", config: { dataSource: { dataSourceType: "STATIC", config: { options: [{ value: "Acme" }, { value: "Other" }] } } } }, { elementType: "SECTION", config: { formElements: [
        { key: "jobTitle", config: { dataSource: { dataSourceType: "STATIC", config: { options: [{ value: "Analyst" }, { value: "Other" }] } } } },
        { key: "hoursOnSitePerWeek", config: { dataSource: { dataSourceType: "STATIC", config: { options: Array.from({ length: 41 }, (_, i) => ({ value: String(i) })) } } } },
      ] } }] } };
    }
    if (p === "/v2025/accounts") {
      const src = /sourceId eq "([^"]+)"/.exec(filters)?.[1];
      const nat = /nativeIdentity eq "([^"]+)"/.exec(filters)?.[1];
      const iid = /identityId eq "([^"]+)"/.exec(filters)?.[1];
      const out: unknown[] = [];
      for (const i of this.identities.values()) {
        if (!i.recordId) continue;
        if (nat && i.recordId !== nat) continue;
        if (iid && i.id !== iid) continue;
        if (src && this.records.get(String(i.recordId))?.sourceId !== src) continue;
        out.push({ identityId: i.id, nativeIdentity: i.recordId, sourceId: src });
      }
      return { status: 200, body: out };
    }
    const idm = /^\/v2025\/identities\/([^/]+)$/.exec(p);
    if (idm) return this.identities.has(idm[1]) ? { status: 200, body: this.identities.get(idm[1]) } : { status: 404, body: {} };
    return { status: 404, body: { path: p } };
  }

  async search(query: string, _fields?: string[], limit = 250): Promise<Record<string, unknown>[]> {
    const all = [...this.identities.values()];
    if (query === "*") return all.map((i) => ({ id: i.id, attributes: i.attributes, manager: { id: (i.managerRef as Record<string, unknown>)?.id } })).slice(0, limit);
    const hits = new Set<Record<string, unknown>>();
    for (const term of query.split(" OR ")) {
      const m = /^(name|attributes\.(\w+)(?:\.exact)?):"(.*)"$/.exec(term.trim());
      if (!m) continue;
      const val = m[3].toLowerCase();
      for (const i of all) {
        const v = m[1] === "name" ? String(i.name ?? "") : String((i.attributes as Record<string, unknown>)[m[2]] ?? "");
        if (v.toLowerCase() === val) hits.add(i);
      }
    }
    return [...hits].slice(0, limit);
  }

  async write(method: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    this.writes.push(`${method} ${path}`);
    const wf = /^\/v2025\/workflows\/([^/]+)$/.exec(path);
    if (method === "PATCH" && wf) {
      const w = this.workflows.get(wf[1])!;
      for (const op of body as { path: string; value: unknown }[]) if (op.path === "/enabled") w.enabled = op.value;
      return { status: 200, body: w };
    }
    if (method === "POST" && path === "/v2025/non-employee-records") {
      if (this.postStatus !== 201) {
        const st = this.postStatus;
        this.postStatus = 201;
        if (st >= 500 || st === 0) {
          this.addRecord(body as Record<string, unknown>); // it landed although the answer was lost
          return { status: st, body: {} };
        }
        return { status: st, body: { detailCode: "400.1 Bad Request" } };
      }
      return { status: 201, body: this.addRecord(body as Record<string, unknown>) };
    }
    const del = /^\/v2025\/non-employee-records\/([^/]+)$/.exec(path);
    if (method === "DELETE" && del) {
      const r = this.records.get(del[1]);
      this.records.delete(del[1]);
      for (const [k, i] of this.identities) if (i.recordId === del[1] && r) this.identities.delete(k);
      return { status: 204, body: {} };
    }
    return { status: 405, body: {} };
  }

  api(): Api {
    return { get: (p) => this.get(p), search: (q, f, l) => this.search(q, f, l) };
  }

  runtime(log: string[] = []): Runtime & { log: (l: string) => void; lines: string[] } {
    const t = this;
    return {
      api: t.api(),
      write: (m, p, b) => t.write(m, p, b),
      now: () => t.clockMs,
      sleep: async (ms) => {
        t.clockMs += ms;
        t.tick();
      },
      log: (l) => log.push(l),
      lines: log,
      todayOffsetHours: 0,
    };
  }
}

describe("loader text helpers", () => {
  it("forms uids, addresses and duplicate keys the way the writer does", () => {
    expect(uidForm("Zoë.O'Brien")).toBe("zoe.obrien");
    expect(addrForm("Søren.Kjær")).toBe("Sren.Kjr");
    expect(nameFold("Søren")).toBe("soren");
    expect(nameFold("St. Corwin")).toBe(nameFold("St Corwin"));
    expect(personKey("Ann", "Lee")).toBe("ann|lee");
    expect(foldable("Āmelia")).toBe(true);
    expect(foldable("Аnn")).toBe(false); // Cyrillic A
    expect(compatChars("Ann™")).toEqual(["™"]);
  });

  it("proves a date order or asks for it", () => {
    expect(dateOrder(["2026-01-05", "2026-02-01"]).order).toBe("ISO");
    expect(dateOrder(["1/15/2026", "3/2/2026"]).order).toBe("MDY");
    expect(dateOrder(["15/1/2026"]).order).toBe("DMY");
    expect(dateOrder(["1/2/2026"]).error).toMatch(/unproven/);
    expect(dateOrder(["1/2/2026"], "MDY").order).toBe("MDY");
    expect(parseDate("3/2/2026", "MDY")).toEqual({ y: 2026, m: 3, d: 2 });
    expect(parseDate("2026-02-30", "ISO")).toBeUndefined();
  });

  it("derives the lifecycle state from the dates", () => {
    const rules = { preLeaverDays: 13, terminatedFinalAfterDays: 30 };
    const today = dayFromIso("2026-03-10")!;
    expect(expectedState(dayFromIso("2026-01-01")!, dayFromIso("2027-01-01")!, today, rules)).toBe("active");
    expect(expectedState(dayFromIso("2026-04-01")!, dayFromIso("2027-01-01")!, today, rules)).toBe("preHire");
    expect(expectedState(dayFromIso("2026-01-01")!, dayFromIso("2026-03-20")!, today, rules)).toBe("preLeaver");
    expect(expectedState(dayFromIso("2026-01-01")!, dayFromIso("2026-03-01")!, today, rules)).toBe("terminated");
    expect(expectedState(dayFromIso("2025-01-01")!, dayFromIso("2026-01-01")!, today, rules)).toBe("terminatedFinal");
  });

  it("finds a quiet window a span touches, in the window's zone", () => {
    const w = [{ label: "morning", tz: "Pacific/Auckland", from: "07:50", to: "08:15" }];
    const at = Date.parse("2026-03-10T18:55:00Z"); // 07:55 NZDT
    expect(quietOverlap(at, at + 60_000, w)).toMatch(/morning/);
    expect(quietOverlap(at - 3_600_000, at - 3_000_000, w)).toBeNull();
    expect(quietOverlap(at, at + 60_000, [{ ...w[0], skippable: true }], true)).toBeNull();
  });
});

describe("the plan", () => {
  it("reads the export against the profile's columns", () => {
    const p = profile();
    expect(readRows(`${HEADER}\n${row({})}\n\n${row({ firstName: "Cy" })}`, p).map((r) => r.line)).toEqual([2, 4]);
    expect(() => readRows("firstName\tlastName\nx\ty", p)).toThrow(/header lacks/);
    expect(() => readRows(`${HEADER}\na\tb`, p)).toThrow(/line 2 has 2 fields/);
    expect(() => readRows(`${HEADER}\n${row({ firstName: "A�n" })}`, p)).toThrow(/U\+FFFD/);
  });

  it("validates rows, resolves managers and codes, reserves logins and reports duplicates", async () => {
    const t = new FakeTenant();
    const p = profile();
    const ref = await reference(t.api(), p);
    expect(ref.sourceId).toBe("src-con");
    expect(ref.formOptions.vendor).toEqual(["Acme", "Other"]);
    expect(ref.suppress).toHaveLength(7);
    const text = [
      HEADER,
      row({}),                                                                      // 2 LOAD
      row({ firstName: "Bob", lastName: "Dup" }),                                   // 3 duplicate of an existing record
      row({ firstName: "Ann", lastName: "Lee", PreferredName: "Annie" }),           // 4 same name as line 2
      row({ firstName: "Cy", lastName: "Old", ManagerEmployeeID: "E900", employeeStartDate: "2025-01-01", employeeEndDate: "2026-02-01" }), // 5 ended row, departed manager -> fallback
      row({ firstName: "Di", lastName: "Live", ManagerEmployeeID: "E900" }),        // 6 live row, terminated manager
      row({ firstName: "Ed", lastName: "Code", DivisionCode: "NOPE", Vendor: "Acme Ltd", HoursPerWeek: "99" }), // 7 bad codes
      row({ firstName: "Fay", lastName: "Soon", employeeEndDate: "2026-03-15" }),   // 8 preLeaver
      row({ firstName: "Gus", lastName: "Dates", employeeStartDate: "2027-01-01", employeeEndDate: "2026-06-01 TBC" }), // 9 start after end + status word
    ].join("\n");
    const rows = readRows(text, p);
    const today = dayFromIso("2026-03-10")!;
    const opt = { map: {}, allowDup: new Set<number>(), allowDupLogin: new Map<number, string>(), allowPreLeaver: false, allowAdInactive: new Set<number>(), allowValue: new Set<number>(), showManagerNames: false, today, transformToday: today, skipLines: new Set<number>(), loaderLogins: new Set<string>() };
    const plan = await planRows(t.api(), p, rows, ref, opt);
    const by = Object.fromEntries(plan.map((r) => [r.line, r]));
    expect(by[2].record).toMatchObject({ accountName: "Ann.Lee", email: "Ann.Lee@vendors.example.com", manager: "mboss", data: { approvalStatus: "approved", locationCode: "NONE", hoursOnSitePerWeek: "40", systemAccessRequired: "AD" } });
    expect(by[2].state).toBe("active");
    expect(by[3].errors[0]).toMatch(/records already exist for this name \(Bob.Dup\); allow_dup 3/);
    expect(by[4].errors[0]).toMatch(/same name as line 2 of this file.*allow_dup 4=Annie.Lee/);
    expect(by[5].record).toMatchObject({ manager: "svc_identity_specialist" });
    expect(by[5].notes.join(" ")).toMatch(/fallback manager/);
    expect(by[6].errors[0]).toMatch(/manager "E900" is terminated \(live rows need active or preLeaver\)/);
    expect(by[7].errors).toEqual(expect.arrayContaining([expect.stringMatching(/DivisionCode "NOPE" is not a REF-Division record/), expect.stringMatching(/Vendor "Acme Ltd" is not a form option \(closest: Acme/), expect.stringMatching(/HoursPerWeek "99" is not a form option/)]));
    expect(by[8].errors[0]).toMatch(/preLeaver.*allow_preleaver/);
    expect(by[9].errors).toEqual(expect.arrayContaining([expect.stringMatching(/status word/), expect.stringMatching(/start .* after end/)]));

    // The allowances turn the refusals into loads, and the digest moves with them.
    const d1 = planDigest("t", plan, ref.suppress.map((w) => w.id), "sha");
    const plan2 = await planRows(t.api(), p, rows, ref, { ...opt, allowDup: new Set([3]), allowDupLogin: new Map([[4, "Annie.Lee"]]), allowPreLeaver: true });
    const by2 = Object.fromEntries(plan2.map((r) => [r.line, r]));
    expect(by2[3].record).toBeTruthy();
    expect(by2[4].record).toMatchObject({ accountName: "Annie.Lee", data: { preferredName: "Annie" } });
    expect(by2[8].state).toBe("preLeaver");
    const d2 = planDigest("t", plan2, ref.suppress.map((w) => w.id), "sha");
    expect(d2.count).toBe(d1.count + 3);
    expect(d2.digest).not.toBe(d1.digest);
    expect(planDigest("t", plan2, ref.suppress.map((w) => w.id), "sha").digest).toBe(d2.digest);
  });
});

describe("the apply, restore and rollback", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ne-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function planFor(t: FakeTenant, p: LoadProfile, text: string) {
    const ref = await reference(t.api(), p);
    const today = dayFromIso("2026-03-10")!;
    const plan = await planRows(t.api(), p, readRows(text, p), ref, { map: {}, allowDup: new Set(), allowDupLogin: new Map(), allowPreLeaver: false, allowAdInactive: new Set(), allowValue: new Set(), showManagerNames: false, today, transformToday: today, skipLines: new Set(), loaderLogins: new Set() });
    const { digest } = planDigest("t", plan, ref.suppress.map((w) => w.id), "sha");
    return { ref, plan, digest, suppress: ref.suppress.map((w) => ({ id: w.id, name: w.name })) };
  }

  it("holds the notices off, creates, settles, re-enables, and records everything on disk", async () => {
    const t = new FakeTenant();
    const p = profile();
    const { plan, digest, suppress, ref } = await planFor(t, p, [HEADER, row({}), row({ firstName: "Cy", lastName: "Two" })].join("\n"));
    const rt = t.runtime();
    const out = await apply(rt, p, { tenant: "t", workDir: dir, plan, digest, file: "f.tsv", fileSha: "sha", profileSha: "psha", sourceId: ref.sourceId, suppress, capMinutes: 1, processingDone: false, knownDisabled: new Set() });
    expect(out.issues).toEqual([]);
    expect(out.exit).toBe(0);
    expect(out.created).toBe(2);
    // Disabled before any POST, re-enabled after, and every workflow is on again.
    const firstPost = t.writes.findIndex((w) => w.startsWith("POST"));
    const disables = t.writes.slice(0, firstPost).filter((w) => w.startsWith("PATCH /v2025/workflows")).length;
    expect(disables).toBe(7);
    expect([...t.workflows.values()].every((w) => w.enabled === true)).toBe(true);
    const res = readJson<Results>(out.results!);
    expect(res.created.map((c) => [c.login, Boolean(c.recordId), c.identityId])).toEqual([["Ann.Lee", true, "id-ann.lee"], ["Cy.Two", true, "id-cy.two"]]);
    expect(res.runs[0].settledAt).toBeTruthy();
    expect(res.reenabledAt).toBeTruthy();
    const state = readJson<State>(out.state!);
    expect(state.restoredAt).toBeTruthy();
    expect(state.workflows.every((w) => w.disabled === false)).toBe(true);
    expect(readdirSync(dir).filter((f) => f.includes("-T0-"))).toHaveLength(1);
  });

  it("leaves the notices OFF when an identity does not settle, and restore finishes the job later", async () => {
    const t = new FakeTenant();
    t.identityDelayReads = 1000; // no identity appears during the apply's cap
    const p = profile();
    const { plan, digest, suppress, ref } = await planFor(t, p, [HEADER, row({})].join("\n"));
    const out = await apply(t.runtime(), p, { tenant: "t", workDir: dir, plan, digest, file: "f.tsv", fileSha: "sha", profileSha: "psha", sourceId: ref.sourceId, suppress, capMinutes: 1, processingDone: false, knownDisabled: new Set() });
    expect(out.exit).toBe(2);
    expect(out.issues[0]).toMatch(/identities not settled: Ann.Lee \(no identity yet\)/);
    expect(out.restore).toMatch(/action=restore state_path=/);
    expect([...t.workflows.values()].filter((w) => w.enabled === false)).toHaveLength(7);
    // A second apply is refused while the STATE is unrestored.
    await expect(apply(t.runtime(), p, { tenant: "t", workDir: dir, plan, digest, file: "f.tsv", fileSha: "sha", profileSha: "psha", sourceId: ref.sourceId, suppress, capMinutes: 1, processingDone: false, knownDisabled: new Set() })).rejects.toThrow(/left notice workflows disabled: run restore/);
    // Restore refuses while the identity is still missing, then succeeds once it exists.
    const r1 = await restore(t.runtime(), p, { statePath: out.state!, force: false, capMinutes: 1, adopt: new Map(), release: new Set() });
    expect(r1.exit).toBe(2);
    expect([...t.workflows.values()].filter((w) => w.enabled === false)).toHaveLength(7);
    t.identityDelayReads = 0;
    t.tick();
    const r2 = await restore(t.runtime(), p, { statePath: out.state!, force: false, capMinutes: 1, adopt: new Map(), release: new Set() });
    expect(r2.exit).toBe(0);
    expect([...t.workflows.values()].every((w) => w.enabled === true)).toBe(true);
    expect(readJson<State>(out.state!).restoredAt).toBeTruthy();
  });

  it("never re-enables a workflow whose definition changed while it was off", async () => {
    const t = new FakeTenant();
    const p = profile();
    const { plan, digest, suppress, ref } = await planFor(t, p, [HEADER, row({})].join("\n"));
    const orig = t.write.bind(t);
    t.write = async (m, path, b) => {
      const r = await orig(m, path, b);
      if (m === "PATCH" && path.endsWith("/wf1") && (b as { value: unknown }[])[0].value === false) t.workflows.get("wf1")!.definition = { steps: { edited: true } };
      return r;
    };
    const out = await apply(t.runtime(), p, { tenant: "t", workDir: dir, plan, digest, file: "f.tsv", fileSha: "sha", profileSha: "psha", sourceId: ref.sourceId, suppress, capMinutes: 1, processingDone: false, knownDisabled: new Set() });
    expect(out.exit).toBe(2);
    expect(out.issues[0]).toMatch(/workflows not confirmed enabled: New Vendor Staff Notice/);
    expect(t.workflows.get("wf1")!.enabled).toBe(false);
    expect([...t.workflows.values()].filter((w) => w.enabled === false)).toHaveLength(1);
    expect(readJson<State>(out.state!).workflows[0]).toMatchObject({ definitionChanged: true, handEnable: true });
  });

  it("never re-sends a POST whose answer was lost: it is found by login", async () => {
    const t = new FakeTenant();
    t.postStatus = 503;
    const p = profile();
    const { plan, digest, suppress, ref } = await planFor(t, p, [HEADER, row({})].join("\n"));
    const out = await apply(t.runtime(), p, { tenant: "t", workDir: dir, plan, digest, file: "f.tsv", fileSha: "sha", profileSha: "psha", sourceId: ref.sourceId, suppress, capMinutes: 1, processingDone: false, knownDisabled: new Set() });
    expect(t.writes.filter((w) => w.startsWith("POST")).length).toBe(1);
    expect(out.exit).toBe(0);
    const res = readJson<Results>(out.results!);
    expect(res.created[0]).toMatchObject({ status: 503, resolvedByLogin: true, uncertain: false });
    expect(res.created[0].recordId).toBeTruthy();
  });

  it("refuses an apply whose plan digest does not match, and a POST refused outright is a failed row", async () => {
    const t = new FakeTenant();
    t.postStatus = 400;
    const p = profile();
    const { plan, digest, suppress, ref } = await planFor(t, p, [HEADER, row({})].join("\n"));
    const out = await apply(t.runtime(), p, { tenant: "t", workDir: dir, plan, digest, file: "f.tsv", fileSha: "sha", profileSha: "psha", sourceId: ref.sourceId, suppress, capMinutes: 1, processingDone: false, knownDisabled: new Set() });
    expect(out.failed).toBe(1);
    expect(out.created).toBe(0);
    expect(out.exit).toBe(2);
    expect([...t.workflows.values()].every((w) => w.enabled === true)).toBe(true);
  });

  it("rolls back what a results file created, with the notices off, and marks the entries deleted", async () => {
    const t = new FakeTenant();
    const p = profile();
    const { plan, digest, suppress, ref } = await planFor(t, p, [HEADER, row({}), row({ firstName: "Cy", lastName: "Two" })].join("\n"));
    const out = await apply(t.runtime(), p, { tenant: "t", workDir: dir, plan, digest, file: "f.tsv", fileSha: "sha", profileSha: "psha", sourceId: ref.sourceId, suppress, capMinutes: 1, processingDone: false, knownDisabled: new Set() });
    expect(out.exit).toBe(0);
    const dry = await rollbackPlan(t.runtime(), out.results!);
    expect(dry.rows.map((r) => r.login)).toEqual(["Ann.Lee", "Cy.Two"]);
    await expect(rollback(t.runtime(), p, { tenant: "t", workDir: dir, resultsPath: out.results!, digest: "wrong", suppress, knownDisabled: new Set(), capMinutes: 1 })).rejects.toThrow(/not this delete plan/);
    const before = t.writes.length;
    const rb = await rollback(t.runtime(), p, { tenant: "t", workDir: dir, resultsPath: out.results!, digest: dry.digest, suppress, knownDisabled: new Set(), capMinutes: 1 });
    expect(rb.exit).toBe(0);
    expect(rb.created).toBe(2);
    const writes = t.writes.slice(before);
    expect(writes.filter((w) => w.startsWith("DELETE"))).toHaveLength(2);
    expect(writes.findIndex((w) => w.startsWith("DELETE"))).toBeGreaterThan(6); // after the 7 disables
    expect([...t.workflows.values()].every((w) => w.enabled === true)).toBe(true);
    expect([...t.records.values()].filter((r) => r.sourceId === "src-con").map((r) => r.accountName)).toEqual(["Bob.Dup"]);
    expect(readJson<Results>(out.results!).created.every((c) => c.deleted)).toBe(true);
    // A second rollback finds nothing to delete.
    expect((await rollbackPlan(t.runtime(), out.results!)).rows).toEqual([]);
  });
});
