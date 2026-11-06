import { describe, it, expect } from "vitest";
import { rankContacts, classifyTier, ManualProvider, ApolloProvider, SnovProvider, discoverContacts, parseContactsCsv } from "../src/contacts/index.js";
import { makeFake, ctx } from "./fakeStore.js";

const job = { title: "Product Management Intern", roleCategory: "product_management" };
const mk = (name: string, title: string, extra: object = {}) => ({ name, title, email: null, linkedinUrl: null, source: "manual", ...extra });

describe("rankContacts", () => {
  it("orders hiring manager > recruiter > functional leader > peer when no warm signals", () => {
    // functional leader here is out-of-function so it can't outrank by function match
    const r = rankContacts([mk("Peer", "Associate Product Manager"), mk("Lead", "Director of Finance"), mk("Rec", "Technical Recruiter"), mk("HM", "Group Product Manager")], job);
    expect(r.map((x) => x.contact.name)).toEqual(["HM", "Rec", "Lead", "Peer"]);
    expect(r[0]!.tier).toBe("hiring_manager");
    expect(r[1]!.tier).toBe("recruiter");
    expect(r.find((x) => x.contact.name === "Peer")!.tier).toBe("peer");
  });
  it("tier classification", () => {
    expect(classifyTier("VP of Product", ["product"])).toBe("functional_leader");
    expect(classifyTier("Senior Product Manager", ["product"])).toBe("hiring_manager");
    expect(classifyTier("University Recruiter", [])).toBe("recruiter");
    expect(classifyTier(null, [])).toBe("other");
  });
  it("warm signals lift a peer above a cold functional leader but not above a hiring manager by default", () => {
    const warm = mk("Warm", "Associate Product Manager", { education: ["Carnegie Mellon University"], pastEmployers: ["Lockheed Martin"] });
    const cold = mk("Cold", "VP of Product");
    const hm = mk("HM", "Product Manager");
    const r = rankContacts([cold, warm, hm], job);
    const pos = (n: string) => r.findIndex((x) => x.contact.name === n);
    expect(pos("HM")).toBeLessThan(pos("Cold"));
    expect(r[pos("Warm")]!.reasons).toEqual(expect.arrayContaining(["warm: CMU/Tepper", "warm: Lockheed Martin"]));
    expect(r.every((x) => x.score <= 100)).toBe(true);
  });
  it("UT Austin signal detected", () => {
    expect(rankContacts([mk("A", "Product Manager", { education: ["UT Austin"] })], job)[0]!.reasons).toContain("warm: UT Austin");
  });
});

describe("providers", () => {
  it("unconfigured providers are skipped, not treated as empty", async () => {
    const f = makeFake();
    const out = await discoverContacts(f.store, ctx, { name: "Acme", domain: "acme.test" }, job, [new ApolloProvider("", fetch), new SnovProvider("", "", fetch)]);
    expect(out.skipped).toEqual(["apollo", "snov"]);
    expect(out.ranked).toEqual([]);
  });
  it("apollo request shape + parse (mocked fetch)", async () => {
    let seen: any;
    const fetchFn = (async (url: string, init: any) => { seen = { url, init }; return { ok: true, json: async () => ({ people: [{ id: "1", first_name: "Ann", last_name_obfuscated: "Sm***", title: "Head of Product", linkedin_url: "https://linkedin.com/in/x" }] }) }; }) as any;
    const res = await new ApolloProvider("k", fetchFn).search({ domain: "acme.test", companyName: "Acme", titles: ["head of product"] });
    expect(seen.url).toBe("https://api.apollo.io/api/v1/mixed_people/api_search");
    expect(seen.init.headers["x-api-key"]).toBe("k");
    expect(JSON.parse(seen.init.body).q_organization_domains_list).toEqual(["acme.test"]);
    expect(res[0]).toMatchObject({ name: "Ann Sm***", title: "Head of Product", email: null });
  });
  it("csv + discover persists ranked contacts", async () => {
    const csv = 'name,title,email,education,past_employers\n"Doe, Jane",Product Manager,jane@acme.test,Carnegie Mellon University,Lockheed Martin\nBob,Recruiter,,,';
    expect(parseContactsCsv(csv)[0]).toMatchObject({ name: "Doe, Jane", education: ["Carnegie Mellon University"] });
    const f = makeFake();
    const out = await discoverContacts(f.store, ctx, { name: "Acme", domain: "acme.test" }, job, [ManualProvider.fromCsv(csv)]);
    expect(out.ranked.length).toBe(2);
    expect(f.contacts.size).toBe(2);
  });
});
