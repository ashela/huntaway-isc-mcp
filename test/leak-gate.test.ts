// leak-gate: fixtures
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_RULES, loadTerms, scanText } from "../scripts/leak-gate.mjs";

const names = (text: string, rules = BUILTIN_RULES) => scanText(text, rules).map((f: { rule: string }) => f.rule);

describe("the leak gate's built-in rules", () => {
  it("catches emails, ids, tenant hosts, credential values, private env keys and local paths", () => {
    expect(names("mail someone@example.test")).toContain("email address");
    expect(names("id 123e4567-e89b-12d3-a456-426614174000")).toContain("uuid");
    expect(names("id 0123456789abcdef0123456789abcdef here")).toContain("32-hex object id");
    expect(names("https://acme-build.api.identitynow.com/v3")).toContain("tenant host");
    expect(names("client_secret = 'abcdefghijklmnopqrstu'")).toContain("credential value");
    expect(names("SAILPOINT_PROD_PAT_SECRET=x")).toContain("private env key");
    expect(names("C:\\Users\\someone\\projects")).toContain("local windows path");
  });

  it("lets documentation placeholders through", () => {
    expect(names("https://<tenant>.api.identitynow.com")).toEqual([]);
    expect(names("https://your-tenant.api.identitynow.com")).toEqual([]);
    expect(names("a readme with no secrets, a short hash cafe1234 and code")).toEqual([]);
  });

  it("applies private terms as whole words and regexes, without echoing them", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-"));
    const file = join(dir, "terms");
    writeFileSync(file, "# comment\nWidgetCo\nre:\\bstag(e|ing)-env\\b\n");
    const rules = loadTerms(file)!;
    expect(rules).toHaveLength(2);
    const hits = scanText("the WidgetCo tenant on staging-env", rules);
    expect(hits.map((h: { rule: string }) => h.rule)).toEqual(['term "WidgetCo"', "term /\\bstag(e|ing)-env\\b/"]);
    expect(scanText("WidgetCorp is a different word", rules)).toEqual([]);
    expect(loadTerms(join(dir, "missing"))).toBeNull();
  });
});
