// The load profile: everything about ONE tenant's non-employee source that
// the loader must know and that this extension must not carry. It is a JSON
// file the operator keeps beside the data (never in the extension, never in
// settings): the source name, how a login, uid and address are formed, which
// file columns feed which record fields, which non-employee sources hold the
// reference codes, which notice workflows go quiet during a load, and the
// tenant's lifecycle timing. Validated here with zod so a wrong profile is
// refused with a path, not discovered mid-load.

import { z } from "zod";

const name = z.string().min(1);

const dataField = z.object({
  /** File column the value comes from. */
  column: name,
  /** Codes must exist as records (accountName) of this non-employee source. */
  ref: z.string().optional(),
  /** Value must be one of this form element's static options (by element key), read from the writer workflow's form. */
  formOption: z.string().optional(),
  /** Value must be one of these. */
  values: z.array(z.string()).optional(),
  /** What a blank cell becomes. Unset: blank is an error when a check applies. */
  blank: z.string().optional(),
  /** Numeric cell: "3.0" reads as "3". */
  numeric: z.boolean().optional(),
  /** A value that needs explicit allowance per line, e.g. "Other". */
  needsAllow: z.string().optional(),
  /** Upper-case the value before checks. */
  upper: z.boolean().optional(),
});

export const LoadProfile = z.object({
  version: z.literal(1),
  /** Non-employee source name (resolved to its id on the tenant). */
  source: name,
  /** Workflow whose trigger names the onboarding form; the form's static option lists validate formOption fields. */
  writerWorkflow: z.string().optional(),
  login: z.object({
    /** Which name leads: "preferred" (preferred name, else first) or "first". */
    lead: z.enum(["preferred", "first"]).default("preferred"),
    /** How many numbered alternatives after the base login. */
    suffixes: z.number().int().min(0).max(20).default(5),
  }).default({}),
  /** Identity uid = prefix + uidForm(login). */
  uidPrefix: z.string().default(""),
  email: z.object({
    prefix: z.string().default(""),
    domain: name,
  }),
  /** Fixed phone written on every record (the writer's value), if any. */
  phone: z.string().optional(),
  columns: z.object({
    firstName: name,
    lastName: name,
    preferredName: z.string().optional(),
    startDate: name,
    endDate: name,
    managerKey: z.string().optional(),
    managerName: z.string().optional(),
    adActive: z.string().optional(),
  }),
  /** Record `data` fields, keyed by data key. */
  data: z.record(dataField).default({}),
  /** Record `data` constants written on every record, e.g. approvalStatus. */
  constants: z.record(z.string()).default({}),
  manager: z.object({
    /** Identity attribute the managerKey column names (e.g. identificationNumber). */
    keyAttribute: z.string().default("identificationNumber"),
    /** A prefix stripped from the key before trying it as a uid (e.g. "PP_"). */
    stripPrefix: z.string().optional(),
    /** Lifecycle states a manager of a live row may be in. */
    okStates: z.array(z.string()).default(["active", "preLeaver"]),
    /** States (or absence) under which an ENDED row's manager is swapped for the fallback. */
    goneStates: z.array(z.string()).default(["terminated", "terminatedFinal", "archived"]),
    /** uid of the service identity substituted for a departed manager on ended rows. */
    fallbackUid: z.string().optional(),
  }).default({}),
  lifecycle: z.object({
    /** Days before the end date from which the state is preLeaver. */
    preLeaverDays: z.number().int().default(13),
    /** Days after the end date from which the state is terminatedFinal. */
    terminatedFinalAfterDays: z.number().int().default(30),
    /** The tenant's identity type for these records. */
    identityType: z.string().default("CONTRACTOR"),
    /** Hours the lifecycle transform's "today" runs ahead of UTC (NZ: 12). */
    transformDayOffsetHours: z.number().default(0),
    /** Earliest start date accepted. */
    earliestStart: z.string().default("2000-01-01"),
    /** End date may be at most this many years ahead. */
    maxYearsAhead: z.number().default(5),
  }).default({}),
  /** Notice workflows disabled for the load, by exact name; each must match one workflow. */
  suppress: z.array(name).default([]),
  /** Identity attributes watched for changes on OTHER identities while the notices are off. */
  watch: z.array(z.string()).default(["cloudLifecycleState", "lastname", "identityType"]),
  settle: z.object({
    stableSeconds: z.number().default(120),
    settleSeconds: z.number().default(180),
    capMinutes: z.number().default(15),
    secondsPerRow: z.number().default(8),
    /** Identity attributes that must be set before a loaded identity counts as settled. */
    requireAttributes: z.array(z.string()).default(["lastname"]),
  }).default({}),
  /** Local-time windows an apply must not touch, e.g. identity processing. */
  quietWindows: z.array(z.object({
    label: name,
    tz: name,
    /** HH:MM local. */
    from: z.string().regex(/^\d{2}:\d{2}$/),
    to: z.string().regex(/^\d{2}:\d{2}$/),
    /** The window is skipped when the operator passes processing_done. */
    skippable: z.boolean().optional(),
  })).default([]),
  /** Null tokens read as blank. */
  nulls: z.array(z.string()).default(["NULL", "N/A", "#N/A", "(NULL)", "-"]),
  /** Values of the adActive column meaning "active". */
  adActiveValues: z.array(z.string()).default(["Yes"]),
  adAllValues: z.array(z.string()).default(["Yes", "No", "Not found"]),
});

export type LoadProfile = z.infer<typeof LoadProfile>;

export function parseProfile(text: string): { profile?: LoadProfile; error?: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { error: `profile is not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const r = LoadProfile.safeParse(json);
  if (!r.success) {
    return { error: "profile invalid: " + r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
  }
  return { profile: r.data };
}
