// Small pure helpers shared by the tools. Kept free of I/O so they are
// unit-testable without a tenant.

export const MAX_CHARS_DEFAULT = 20000;

export type Json = unknown;

export function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Appends query parameters, skipping undefined ones. */
export function q(path: string, params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) search.set(k, String(v));
  }
  const qs = search.toString();
  return qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path;
}

/** Keeps responses usable in context; says plainly when something was cut. */
export function clip(obj: Json, maxChars: number): Json {
  const text = JSON.stringify(obj) ?? "null";
  if (text.length <= maxChars) return obj;
  return {
    _truncated: true,
    _original_chars: text.length,
    _shown_chars: maxChars,
    _note: "Response clipped. Narrow the query or raise max_chars to see the rest.",
    preview: text.slice(0, maxChars),
  };
}

/** A listing's rows whichever envelope the endpoint uses: a bare list,
 *  `items`, or `results` (form-definitions answers `{results, count}`). */
export function rows(body: Json): Record<string, unknown>[] | null {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    for (const key of ["items", "results"]) {
      if (Array.isArray(o[key])) return o[key] as Record<string, unknown>[];
    }
  }
  return null;
}

export function asRecord(value: Json): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asList(value: Json): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

/** Attributes still holding an unresolved template or a raw JSONPath. */
export function leakedAttributes(attrs: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "string" && (v.includes("{{") || v.startsWith("$."))) out[k] = v;
  }
  return out;
}

export function lower(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

/** Exact name match first, then substring; one match or an explanation. */
export function matchByName<T extends Record<string, unknown>>(
  items: T[],
  name: string,
  kind: string,
): { match?: T; error?: string; candidates?: unknown[] } {
  const wanted = name.toLowerCase();
  let matches = items.filter((i) => lower(i.name) === wanted);
  if (!matches.length) matches = items.filter((i) => lower(i.name).includes(wanted));
  if (!matches.length) return { error: `no ${kind} matched ${JSON.stringify(name)}` };
  if (matches.length > 1) {
    return { error: `${JSON.stringify(name)} is ambiguous`, candidates: matches.map((m) => m.name) };
  }
  return { match: matches[0] };
}
