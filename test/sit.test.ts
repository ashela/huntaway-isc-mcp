// leak-gate: fixtures
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Tagger, appendResult, asAddresses, cards, executionsSince, failure, formsInHistory, leakCheck, parseSitProfile, readRegister,
  readResults, runChain, sends, stepsRun, type ChainApi, type SitProfile,
} from "../src/server/sit.js";

const PROFILE: SitProfile = parseSitProfile(JSON.stringify({
  version: 1,
  roleMailboxes: { IS: "^identityspecialist@", CAM: "^camadmin@" },
  generatedSuffixes: ["@tmp.example.test"],
  forbiddenLaunchers: ["Urgent Disable"],
  forbiddenFormKeys: ["target"],
  fixtureToken: "sitfx",
})).profile!;

const HISTORY: Record<string, unknown>[] = [
  { type: "WorkflowExecutionStarted", attributes: { input: { interactiveProcessId: "pid-1", identity: { id: "ident-1" } } } },
  { type: "ActivityTaskCompleted", attributes: { stepName: "Pre-Check", result: { formInstanceId: "form-1" } } },
  { type: "ActivityTaskScheduled", attributes: { stepName: "Notify Submitter", technicalName: "notifySubmitter", task: "sp:send-email", input: { recipientEmailList: "[Someone.Here@corp.example.test, identityspecialist@corp.example.test]", carbonCopy: ["camadmin@corp.example.test"], subject: "Submitted for Jane.Fixture@tmp.example.test", body: { emailTemplate: { subject: "x", body: "<p>Hello {{ identity.name }} at $.data.x</p>" } } } } },
  { type: "ActivityTaskScheduled", attributes: { stepName: "Card", task: "sp:interactive-message", input: { interactiveMessage: { category: "info", title: "Submitted", message: "<b>Done</b> ok" } } } },
  { type: "ActivityTaskCompleted", attributes: { stepName: "Notify Submitter" } },
  { type: "ActivityTaskFailed", attributes: { stepName: "Write Record", error: { message: "boom" } } },
];

describe("SIT evidence helpers", () => {
  const tagger = new Tagger(PROFILE);

  it("tags recipients by role, generated suffix or domain, and redacts evidence", () => {
    expect(asAddresses("[A@x.test, \"b@y.test\"]")).toEqual(["a@x.test", "b@y.test"]);
    expect(tagger.tag("IdentitySpecialist@corp.example.test")).toBe("IS");
    expect(tagger.tag("jane@tmp.example.test")).toBe("GENERATED");
    expect(tagger.tag("someone@corp.example.test")).toBe("OTHER:corp.example.test");
    expect(tagger.tag("IS")).toBe("IS");
    expect(tagger.redact("mail camadmin@corp.example.test and bob@other.test")).toBe("mail <CAM> and <email@other.test>");
  });

  it("reads steps, sends, cards and the failure from a history, with the leak check", () => {
    expect(stepsRun(HISTORY)).toEqual(["Pre-Check", "Notify Submitter"]);
    const s = sends(HISTORY, tagger, PROFILE);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ step: "Notify Submitter", technical: "notifySubmitter", to: ["OTHER:corp.example.test", "IS"], cc: ["CAM"], subject: "Submitted for <GENERATED>" });
    expect(s[0].body).toBe("Hello {{ identity.name }} at $.data.x");
    expect(s[0].leaks).toEqual(["{{", "$.path", "generated-address"]);
    expect(cards(HISTORY)).toEqual([{ category: "info", title: "Submitted", message: "Done ok" }]);
    expect(failure(HISTORY)).toMatch(/^Write Record: .*boom/);
    expect(formsInHistory(HISTORY)).toEqual(["form-1"]);
    expect(leakCheck("sent 2026-10-17T10:00 with []")).toEqual(["ISO", "[]"]);
  });

  it("asks for executions from a margin earlier and cuts exactly, and never asks about the future", async () => {
    const calls: string[] = [];
    const api = {
      now: () => Date.parse("2026-10-17T10:10:00Z"),
      async get(path: string) {
        calls.push(path);
        return { status: 200, body: [{ id: "e1", startTime: "2026-10-17T10:00:30Z" }, { id: "e2", startTime: "2026-10-17T09:59:59Z" }] };
      },
    };
    const rows = await executionsSince(api, "wf1", "2026-10-17T10:00:00Z");
    expect(rows.map((r) => r.id)).toEqual(["e1"]);
    expect(decodeURIComponent(calls[0])).toContain('start_time ge "2026-10-17T09:58:00Z"');
    expect(await executionsSince(api, "wf1", "2026-10-17T11:00:00Z")).toEqual([]);
  });
});

describe("the case register and results log", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sit-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads a list or an object holding one, and keeps the latest verdict per case", () => {
    expect(readRegister(JSON.stringify([{ id: "C-1", title: "a" }])).map((c) => c.id)).toEqual(["C-1"]);
    expect(readRegister(JSON.stringify({ meta: 1, cases: [{ id: "C-2" }] })).map((c) => c.id)).toEqual(["C-2"]);
    expect(() => readRegister("{}")).toThrow(/not a list of cases/);
    const p = join(dir, "r.jsonl");
    appendResult(p, { case: "C-1", status: "FAIL", evidence: "x", ts: "t1" });
    appendResult(p, { case: "C-1", status: "PASS", evidence: "y", ts: "t2" });
    writeFileSync(p, readFileSync(p, "utf8") + "{not json\n");
    const r = readResults(p);
    expect(r.get("C-1")!.map((v) => v.status)).toEqual(["FAIL", "PASS"]);
  });
});

/** A tenant with one launcher whose workflow opens two forms and sends a mail. */
function fakeChainTenant() {
  let clock = Date.parse("2026-10-17T10:00:00Z");
  const writes: string[] = [];
  const forms = new Map<string, Record<string, unknown>>([
    ["f-a", { id: "f-a", formDefinitionId: "d-pre", state: "ASSIGNED", formErrors: [] }],
    ["f-b", { id: "f-b", formDefinitionId: "d-full", state: "ASSIGNED", formErrors: [] }],
  ]);
  const history: Record<string, unknown>[] = [{ type: "WorkflowExecutionStarted", attributes: { input: { interactiveProcessId: "pid-9" } } }];
  let execStatus = "Executing";
  let submitted = 0;
  const api: ChainApi & { writes: string[] } = {
    writes,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    async get(path) {
      if (path.startsWith("/beta/launchers")) return { status: 200, body: [{ id: "l1", name: "Onboard", disabled: false, reference: { id: "wf1" } }, { id: "l2", name: "Urgent Disable", reference: { id: "wf2" } }] };
      if (path === "/v2025/workflows/wf1") return { status: 200, body: { id: "wf1", name: "Onboarding Flow" } };
      if (path.startsWith("/v2025/form-definitions")) return { status: 200, body: [{ id: "d-pre", name: "Pre-Check" }, { id: "d-full", name: "Details" }] };
      if (path.startsWith("/v2025/workflows/wf1/executions")) return { status: 200, body: [{ id: "e-other", startTime: "2026-10-17T09:59:30Z" }, { id: "e-mine", startTime: "2026-10-17T10:00:01Z" }] };
      if (path === "/v2025/workflow-executions/e-other/history") return { status: 200, body: [{ type: "WorkflowExecutionStarted", attributes: { input: { interactiveProcessId: "someone-else" } } }] };
      if (path === "/v2025/workflow-executions/e-mine/history") return { status: 200, body: history };
      if (path === "/v2025/workflow-executions/e-mine") return { status: 200, body: { id: "e-mine", status: execStatus } };
      const f = /^\/beta\/form-instances\/(.+)$/.exec(path);
      if (f) return { status: 200, body: forms.get(f[1]) ?? {} };
      return { status: 404, body: {} };
    },
    async write(method, path, body) {
      writes.push(`${method} ${path}`);
      if (path === "/beta/launchers/l1/launch") {
        history.push({ type: "ActivityTaskCompleted", attributes: { stepName: "Open Pre-Check", result: { formInstanceId: "f-a" } } });
        return { status: 200, body: { interactiveProcessId: "pid-9" } };
      }
      const f = /^\/beta\/form-instances\/(.+)$/.exec(path);
      if (method === "PATCH" && f) {
        const form = forms.get(f[1])!;
        const data = (body as { path: string; value: unknown }[]).find((op) => op.path === "/formData")?.value as Record<string, unknown>;
        if (f[1] === "f-b" && !data.lastName) {
          form.formErrors = [{ key: "lastName", messages: ["required"] }];
          return { status: 200, body: form };
        }
        form.state = "SUBMITTED";
        submitted++;
        if (f[1] === "f-a") history.push({ type: "ActivityTaskCompleted", attributes: { stepName: "Open Details", result: { config: { formInstanceId: "f-b" } } } });
        if (f[1] === "f-b") {
          history.push({ type: "ActivityTaskScheduled", attributes: { stepName: "Notify", task: "sp:send-email", input: { recipientEmailList: "identityspecialist@corp.example.test", subject: "Done" } } });
          history.push({ type: "ActivityTaskCompleted", attributes: { stepName: "Notify" } });
          execStatus = "Completed";
        }
        return { status: 200, body: form };
      }
      if (path.endsWith("/cancel")) {
        execStatus = "Canceled";
        return { status: 200, body: {} };
      }
      return { status: 405, body: {} };
    },
  };
  return { api, submittedCount: () => submitted };
}

describe("the launcher chain", () => {
  it("launches, finds its own execution, walks the forms in order and returns evidence", async () => {
    const { api } = fakeChainTenant();
    const r = await runChain(api, { launcher: "Onboard", steps: [{ form: "Pre-Check", data: { firstName: "Sitfx", lastName: "One" } }, { form: "Details", data: { firstName: "Sitfx", lastName: "One", hours: 40 } }], waitSeconds: 60, profile: PROFILE });
    expect(r.execution).toBe("e-mine");
    expect(r.workflow).toBe("Onboarding Flow");
    expect(r.forms.map((f) => [f.name, f.state])).toEqual([["Pre-Check", "SUBMITTED"], ["Details", "SUBMITTED"]]);
    expect(r.status).toBe("Completed");
    expect(r.sends[0]).toMatchObject({ step: "Notify", to: ["IS"] });
    expect(api.writes).toEqual(["POST /beta/launchers/l1/launch", "PATCH /beta/form-instances/f-a", "PATCH /beta/form-instances/f-b"]);
  });

  it("reports a form the tenant refused, and cancels when asked", async () => {
    const { api } = fakeChainTenant();
    const r = await runChain(api, { launcher: "Onboard", steps: [{ data: { firstName: "Sitfx", lastName: "Two" } }, { form: "Details", data: { firstName: "Sitfx" } }], cancel: true, waitSeconds: 10, profile: PROFILE });
    expect(r.forms[1]).toMatchObject({ name: "Details", state: "ASSIGNED" });
    expect(r.forms[1].errors).toEqual([{ key: "lastName", messages: ["required"] }]);
    expect(r.cancelled).toBe(true);
    expect(r.status).toBe("Canceled");
  });

  it("refuses an excluded launcher, an excluded form key, a wrong form and a name without the fixture token", async () => {
    const { api } = fakeChainTenant();
    const base = { waitSeconds: 10, profile: PROFILE };
    await expect(runChain(api, { ...base, launcher: "Urgent Disable", steps: [] })).rejects.toThrow(/excluded by the SIT profile/);
    await expect(runChain(api, { ...base, launcher: "Onboard", steps: [{ data: { target: "x" } }] })).rejects.toThrow(/excluded key/);
    await expect(runChain(api, { ...base, launcher: "Onboard", steps: [{ data: { firstName: "Jane", lastName: "Real" } }] })).rejects.toThrow(/fixture token/);
    await expect(runChain(api, { ...base, launcher: "Onboard", steps: [{ form: "Details", data: { firstName: "Sitfx", lastName: "X" } }] })).rejects.toThrow(/expected form "Details", got "Pre-Check"/);
    expect(api.writes.filter((w) => w.startsWith("PATCH"))).toEqual([]);
  });
});
