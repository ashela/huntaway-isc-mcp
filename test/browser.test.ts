import { describe, expect, it } from "vitest";
import { IscClient, type HttpFn } from "../src/server/isc.js";
import { CATEGORIES, PAGE, listCategory, readObject, summarise } from "../src/browser.js";

const tenant = { key: "t", label: "T", baseUrl: "https://t.example.test", clientId: "id", clientSecret: "s", isDefault: true };

/** A fake ISC: a token endpoint, one paged listing of `total` objects, and one detail. */
function fakeIsc(total: number, status = 200) {
  const calls: string[] = [];
  const http: HttpFn = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    if (u.pathname === "/oauth/token") return { status: 200, text: JSON.stringify({ access_token: "tok", expires_in: 3600 }), headers: new Headers() };
    if (status !== 200) return { status, text: "{}", headers: new Headers() };
    if (u.pathname === "/v2025/sources/s7") return { status: 200, text: JSON.stringify({ id: "s7", name: "Seven", connectorAttributes: {} }), headers: new Headers() };
    const limit = Number(u.searchParams.get("limit") ?? total);
    const offset = Number(u.searchParams.get("offset") ?? 0);
    const rows = [];
    for (let i = offset; i < Math.min(total, offset + limit); i++) rows.push({ id: `s${i}`, name: `Source ${String(total - i).padStart(4, "0")}`, type: "JDBC" });
    return { status: 200, text: JSON.stringify(rows), headers: new Headers() };
  };
  return { isc: new IscClient([tenant], "test", http, async () => undefined), calls };
}

const sources = CATEGORIES.find((c) => c.id === "sources")!;
const workflows = CATEGORIES.find((c) => c.id === "workflows")!;

describe("the asset browser", () => {
  it("pages a paged listing until a short page and sorts by name", async () => {
    const { isc, calls } = fakeIsc(PAGE + 3);
    const list = await listCategory(isc, "t", sources);
    expect(list).toHaveLength(PAGE + 3);
    expect(calls.filter((c) => c.startsWith("/v2025/sources"))).toEqual([
      `/v2025/sources?limit=${PAGE}&offset=0`,
      `/v2025/sources?limit=${PAGE}&offset=${PAGE}`,
    ]);
    expect(list[0].name).toBe("Source 0001");
  });

  it("reads an unpaged listing once", async () => {
    const { isc, calls } = fakeIsc(5);
    await listCategory(isc, "t", workflows);
    expect(calls.filter((c) => c.startsWith("/beta/workflows"))).toEqual(["/beta/workflows"]);
  });

  it("explains a 403 as a credential without user context", async () => {
    const { isc } = fakeIsc(0, 403);
    await expect(listCategory(isc, "t", workflows)).rejects.toThrow(/user context/);
  });

  it("reads one object as pretty JSON from its detail path", async () => {
    const { isc } = fakeIsc(1);
    const text = await readObject(isc, "t", sources, { id: "s7", name: "Seven" });
    expect(JSON.parse(text)).toMatchObject({ id: "s7", name: "Seven" });
    expect(text).toContain("\n  ");
  });

  it("summarises the fields a row needs", () => {
    expect(summarise(sources, { type: "Active Directory", authoritative: true })).toBe("Active Directory, authoritative");
    expect(summarise(workflows, { enabled: false, trigger: { type: "EVENT" } })).toBe("disabled, EVENT");
    expect(summarise(CATEGORIES.find((c) => c.id === "sod-policies")!, { name: "x" })).toBe("");
  });

  it("has a detail path for every category", () => {
    for (const c of CATEGORIES) expect(c.detail({ id: "abc", name: "n" })).toMatch(/^\/(v3|v2025|beta)\//);
  });
});
