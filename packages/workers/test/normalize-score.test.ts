import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Preferences } from "@ros/core";
import { detectAts, normalizeJob, extractSalary, classifyRole } from "../src/normalize/index.js";
import { scoreJob } from "../src/score/index.js";
import { parseGreenhouse, parseLever, parseAshby } from "../src/connectors/index.js";
import { runNormalizeStage, runScoreStage } from "../src/stages/index.js";
import { makeFakeStore, ctx } from "./bStore.js";

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));

describe("detectAts", () => {
  it("greenhouse", () => expect(detectAts("https://boards.greenhouse.io/stripe/jobs/12345")).toEqual({ kind: "greenhouse", board: "stripe", jobId: "12345" }));
  it("greenhouse new host", () => expect(detectAts("https://job-boards.greenhouse.io/acme/jobs/99?gh_src=x").jobId).toBe("99"));
  it("lever", () => expect(detectAts("https://jobs.lever.co/acme/abc-123")).toEqual({ kind: "lever", board: "acme", jobId: "abc-123" }));
  it("ashby", () => expect(detectAts("https://jobs.ashbyhq.com/zeta/1111/application").kind).toBe("ashby"));
  it("careers page w/ gh_jid", () => expect(detectAts("https://acme.com/careers?gh_jid=777")).toMatchObject({ kind: "greenhouse", jobId: "777" }));
  it("unknown", () => expect(detectAts("https://acme.com/careers/pm").kind).toBe("unknown"));
});

describe("normalize", () => {
  const jd = `Product Management Intern at Acme
Location: Austin, TX
Summer 2027 MBA internship. Pay: $50 - $60 per hour. Return offer potential.
Apply by Jan 15, 2027.`;
  it("pasted text", () => {
    const n = normalizeJob({ text: jd });
    expect(n.title).toBe("Product Management Intern");
    expect(n.company).toBe("Acme");
    expect(n.location).toBe("Austin, TX");
    expect(n.isInternship).toBe(true);
    expect(n.eligibility.summer2027).toBe(true);
    expect(n.eligibility.mbaRequired).toBe(true);
    expect(n.roleCategory).toBe("product_management");
    expect(n.salaryMin).toBe(50); expect(n.salaryMax).toBe(60);
    expect(n.deadline).toBe("2027-01-15");
  });
  it("ATS url dedupes across tracking params", () => {
    const a = normalizeJob({ url: "https://boards.greenhouse.io/stripe/jobs/12345?gh_src=a", text: "Strategy Intern at Stripe\nintern" });
    const b = normalizeJob({ url: "https://boards.greenhouse.io/stripe/jobs/12345", text: "Different text\nintern" });
    expect(a.dedupeKey).toBe(b.dedupeKey);
  });
  it("same role different casing/suffix dedupes", () => {
    const mk = (c: string) => normalizeJob({ job: { title: "Product Marketing Intern", company: c, location: "NYC" } });
    expect(mk("Acme, Inc.").dedupeKey).toBe(mk("ACME").dedupeKey);
  });
  it("does not invent unknowns", () => {
    const n = normalizeJob({ url: "https://acme.com/careers/x" });
    expect(n.salaryMin).toBeNull(); expect(n.isInternship).toBeNull(); expect(n.eligibility.summer2027).toBeNull();
  });
  it("salary variants", () => {
    expect(extractSalary("$110k - $130k per year")).toMatchObject({ min: 110000, max: 130000 });
    expect(extractSalary("no pay info").min).toBeNull();
  });
  it("classifier", () => {
    expect(classifyRole("Product Marketing Manager Intern")).toBe("product_marketing");
    expect(classifyRole("Chief of Staff Intern")).toBe("founders_office");
    expect(classifyRole("Search Fund Associate")).toBe("vc_pe_search");
    expect(classifyRole("Barista")).toBe("other");
  });
});

describe("score", () => {
  const base = (over: any = {}) => normalizeJob({ job: { title: "Product Management Intern", company: "Acme", location: "Austin, TX", description: "Summer 2027 MBA internship. Return offer. Own the roadmap. Hybrid. $55/hr", ...over } });
  it("qualifies a strong fit", () => { const s = scoreJob(base()); expect(s.decision).toBe("qualify"); expect(s.hardRejects).toEqual([]); });
  it("hard reject: not internship", () => expect(scoreJob(base({ title: "Senior Product Manager", description: "Full-time role. Own the roadmap." })).hardRejects).toContain("not an internship"));
  it("hard reject: wrong season", () => { const s = scoreJob(base({ description: "Summer 2026 MBA internship" })); expect(s.decision).toBe("archive"); expect(s.hardRejects[0]).toMatch(/season/); });
  it("hard reject: undergrad only", () => { const s = scoreJob(base({ description: "Summer 2027 internship for undergraduate students only" })); expect(s.hardRejects).toContain("not open to MBA students"); });
  it("hard reject: excluded company/location", () => {
    const p = Preferences.parse({ excludedCompanies: ["acme"], locationsExcluded: ["austin"] });
    expect(scoreJob(base(), p).hardRejects).toEqual(expect.arrayContaining(["excluded company", "excluded location"]));
  });
  it("hard reject: pay below minimum", () => expect(scoreJob(base(), { minHourlyUsd: 80 }).hardRejects.join()).toMatch(/pay below/));
  it("earlier role order scores higher", () => {
    const pm = scoreJob(base()).roleFit; const vc = scoreJob(base({ title: "Search Fund Intern" })).roleFit;
    expect(pm).toBeGreaterThan(vc);
  });
  it("unknown role -> archive", () => expect(scoreJob(base({ title: "Warehouse Intern", description: "Summer 2027 intern" })).decision).toBe("archive"));
});

describe("connectors (doc-derived fixtures, NOT live-verified)", () => {
  it("greenhouse", () => { const [j] = parseGreenhouse("vaulttec", fx("greenhouse.doc-derived.json")); expect(j!.applyUrl).toContain("/jobs/127817"); expect(j!.description).toContain("MBA"); });
  it("lever", () => { const [j] = parseLever("acme", fx("lever.doc-derived.json")); expect(j!.salaryMin).toBe(110000); expect(j!.applyUrl).toContain("/apply"); });
  it("ashby filters unlisted", () => { const js = parseAshby("zeta", fx("ashby.doc-derived.json")); expect(js).toHaveLength(1); expect(js[0]!.title).toMatch(/Founder/); });
  it("feeds normalize end to end", () => {
    const n = normalizeJob({ job: parseLever("acme", fx("lever.doc-derived.json"))[0]! });
    expect(n.atsKind).toBe("lever"); expect(n.roleCategory).toBe("gtm_strategy"); expect(n.isInternship).toBe(true);
  });
});

describe("stages", () => {
  it("ingest -> normalize -> score; duplicate detected; borderline raises exception", async () => {
    const f = makeFakeStore();
    const req = { source: "manual_text" as const, text: "Product Management Intern at Acme\nLocation: Austin, TX\nSummer 2027 MBA internship. Return offer. Own the roadmap. $55/hr" };
    const i1 = await f.store.createIngestion(ctx, req);
    await runNormalizeStage(f.store, ctx, i1.id);
    const jobId = f.ings.get(i1.id)!.jobId!;
    expect(f.jobs.get(jobId)!.stage).toBe("normalized");
    await runScoreStage(f.store, ctx, jobId);
    expect(f.jobs.get(jobId)!.stage).toBe("qualified");
    const i2 = await f.store.createIngestion(ctx, req);
    await runNormalizeStage(f.store, ctx, i2.id);
    expect(f.ings.get(i2.id)!.jobId).toBe(jobId);
    expect(f.events.map((e) => e.kind)).toEqual(expect.arrayContaining(["job.normalized", "job.scored", "job.duplicate"]));
    expect(f.jobs.size).toBe(1);
  });
});
