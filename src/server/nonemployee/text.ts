// Pure helpers of the loader: name normalisation and folding, the login,
// uid and address forms, dates and the expected lifecycle state, digests.
// Ported from the Python loader's own helpers so a name that was a duplicate
// there is a duplicate here.

import { createHash } from "node:crypto";

const APOSTROPHES = ["’", "‘", "´", "ʼ", "ʻ", "`"];

/** NFC, every Unicode space a space, curly apostrophes plain, trimmed; a null token reads as blank. */
export function clean(v: string | undefined | null, nulls: Iterable<string>): string {
  let s = (v ?? "").normalize("NFC");
  s = s.replace(/\p{Zs}/gu, " ");
  for (const a of APOSTROPHES) s = s.split(a).join("'");
  s = s.trim();
  const set = new Set([...nulls].map((n) => n.toUpperCase()));
  return set.has(s.toUpperCase()) ? "" : s;
}

export function stripMarks(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "");
}

/** The uid transform minus the prefix: marks removed, [^a-zA-Z0-9._] dropped, lower-cased. */
export function uidForm(s: string): string {
  return stripMarks(s).replace(/[^a-zA-Z0-9._]/g, "").toLowerCase();
}

/** The address local part: marks removed, [^A-Za-z0-9._] dropped, case kept. */
export function addrForm(s: string): string {
  return stripMarks(s).replace(/[^A-Za-z0-9._]/g, "");
}

const FOLD: Record<string, string> = {
  "ø": "o", "Ø": "O", "ł": "l", "Ł": "L", "æ": "ae", "Æ": "AE", "œ": "oe", "Œ": "OE", "ß": "ss", "ẞ": "SS",
  "đ": "d", "Đ": "D", "ð": "d", "Ð": "D", "þ": "th", "Þ": "TH", "ı": "i", "ħ": "h", "Ħ": "H", "ŋ": "ng",
  "Ŋ": "NG", "ŧ": "t", "Ŧ": "T", "ə": "e", "Ə": "E", "ĸ": "k", "ƒ": "f", "ŀ": "l", "Ŀ": "L",
};

/** Duplicate-key form of a name: NFKD, letters NFD does not decompose folded, marks dropped, [a-z0-9] kept. */
export function nameFold(s: string): string {
  const folded = [...(s ?? "").normalize("NFKD")].map((c) => FOLD[c] ?? c).join("");
  return folded.replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Every letter is a letter that folds to a plain a-z form; a look-alike would dodge the duplicate key. */
export function foldable(s: string): boolean {
  for (const c of s) {
    if (" .'-".includes(c)) continue;
    if (!/\p{L}/u.test(c) || !nameFold(c)) return false;
  }
  return true;
}

/** Characters with a compatibility decomposition (superscripts, circled, fullwidth, ligatures). */
export function compatChars(s: string): string[] {
  const out = new Set<string>();
  for (const c of s) {
    if (/[\s.'-]/.test(c)) continue;
    if (c.normalize("NFKD") !== c.normalize("NFD")) out.add(c);
  }
  return [...out].sort();
}

export const NAME_RX = /^'?\p{L}+(?:[ .'\-]\p{L}+|\.)*\.?$/u;
export const ATOM_RX = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;

export function personKey(first: string, last: string): string {
  return `${nameFold(first)}|${nameFold(last)}`;
}

export function digest(x: unknown, n = 12): string {
  return createHash("sha256").update(stableJson(x)).digest("hex").slice(0, n);
}

/** JSON with sorted object keys, so a digest does not depend on insertion order. */
export function stableJson(x: unknown): string {
  return JSON.stringify(sortKeys(x));
}

function sortKeys(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (x && typeof x === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(x as Record<string, unknown>).sort()) out[k] = sortKeys((x as Record<string, unknown>)[k]);
    return out;
  }
  return x;
}

// ---------------------------------------------------------------- dates

export type DateOrder = "ISO" | "MDY" | "DMY";

/** A calendar date as days since epoch, free of time zones. */
export interface Day {
  y: number;
  m: number;
  d: number;
}

export function dayFromIso(s: string): Day | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return undefined;
  const day = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  return validDay(day) ? day : undefined;
}

function validDay(day: Day): boolean {
  const t = Date.UTC(day.y, day.m - 1, day.d);
  const back = new Date(t);
  return back.getUTCFullYear() === day.y && back.getUTCMonth() === day.m - 1 && back.getUTCDate() === day.d;
}

export function dayToIso(day: Day): string {
  return `${day.y}-${String(day.m).padStart(2, "0")}-${String(day.d).padStart(2, "0")}`;
}

export function dayNumber(day: Day): number {
  return Math.round(Date.UTC(day.y, day.m - 1, day.d) / 86_400_000);
}

export function daysBetween(a: Day, b: Day): number {
  return dayNumber(a) - dayNumber(b);
}

export function addDays(day: Day, n: number): Day {
  const t = new Date(Date.UTC(day.y, day.m - 1, day.d) + n * 86_400_000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** The calendar day at a UTC instant shifted by `offsetHours` (the lifecycle transform's "today"). */
export function dayAt(utcMs: number, offsetHours: number): Day {
  const t = new Date(utcMs + offsetHours * 3_600_000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** The date order a column proves: ISO throughout, or slash dates with a part above 12 settling M/D vs D/M.
 *  An unprovable column needs `forced`. */
export function dateOrder(values: string[], forced?: DateOrder): { order?: DateOrder; error?: string } {
  const vals = values.map((v) => v.split(" ")[0]).filter(Boolean);
  if (!vals.length) return { order: forced ?? "ISO" };
  if (vals.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))) return { order: "ISO" };
  const parts = vals.map((v) => /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v));
  if (parts.some((p) => !p)) {
    return { error: `mixed or unknown date formats (e.g. ${vals.filter((_, i) => !parts[i]).slice(0, 3).join(", ")})` };
  }
  const first = parts.map((p) => Number(p![1]));
  const second = parts.map((p) => Number(p![2]));
  const firstOver = first.some((x) => x > 12);
  const secondOver = second.some((x) => x > 12);
  if (firstOver && secondOver) return { error: "both parts exceed 12 in some rows: the column mixes orders" };
  if (firstOver) return forced && forced !== "DMY" ? { error: `a first part above 12 proves D/M, not ${forced}` } : { order: "DMY" };
  if (secondOver) return forced && forced !== "MDY" ? { error: `a second part above 12 proves M/D, not ${forced}` } : { order: "MDY" };
  if (forced === "MDY" || forced === "DMY") return { order: forced };
  return { error: "no day above 12, so M/D vs D/M is unproven: pass date_order MDY or DMY" };
}

export function parseDate(v: string, order: DateOrder): Day | undefined {
  const s = (v ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return order === "ISO" ? dayFromIso(s) : undefined;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (!m || order === "ISO") return undefined;
  const day = order === "MDY" ? { y: Number(m[3]), m: Number(m[1]), d: Number(m[2]) } : { y: Number(m[3]), m: Number(m[2]), d: Number(m[1]) };
  return validDay(day) ? day : undefined;
}

export interface LifecycleRules {
  preLeaverDays: number;
  terminatedFinalAfterDays: number;
}

/** The lifecycle state an approved record's dates give on `today`. */
export function expectedState(start: Day, end: Day, today: Day, rules: LifecycleRules): string {
  if (daysBetween(today, end) >= rules.terminatedFinalAfterDays) return "terminatedFinal";
  if (daysBetween(end, today) < 0) return "terminated";
  if (daysBetween(start, today) > 0) return "preHire";
  if (daysBetween(end, today) <= rules.preLeaverDays) return "preLeaver";
  return "active";
}

export const ENDED = new Set(["terminated", "terminatedFinal"]);

// ---------------------------------------------------------------- quiet windows

export interface QuietWindow {
  label: string;
  tz: string;
  from: string;
  to: string;
  skippable?: boolean;
}

/** Wall-clock minutes of a UTC instant in a zone. */
function localMinutes(utcMs: number, tz: string): { day: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { day: `${get("year")}-${get("month")}-${get("day")}`, minutes: get("hour") * 60 + get("minute") };
}

const hm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/** The first window the span [startMs, endMs] touches, sampled every 5 minutes; null when clear. */
export function quietOverlap(startMs: number, endMs: number, windows: QuietWindow[], skip = false): string | null {
  for (const w of windows) {
    if (w.skippable && skip) continue;
    const a = hm(w.from);
    const b = hm(w.to);
    for (let t = startMs; t <= endMs + 1; t += 5 * 60_000) {
      const { minutes } = localMinutes(Math.min(t, endMs), w.tz);
      const inside = a <= b ? minutes >= a && minutes <= b : minutes >= a || minutes <= b;
      if (inside) return `${w.label} (${w.from}-${w.to} ${w.tz})`;
      if (t > endMs) break;
    }
  }
  return null;
}
