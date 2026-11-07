import { describe, expect, it } from "vitest";
import { Preferences, type StructuredJobInput } from "@ros/core";
import { normalizeJob } from "../../src/normalize/index.js";
import { deadlinePriority, isExpired, matchTargetRole, qualifyJob, seasonOk, titleMatches, locationOk } from "../../src/qualify/index.js";

const NOW = new Date("2026-11-07T12:00:00Z");
const prefs = (p: Record<string, unknown> = {}) => Preferences.parse(p);
const job = (o: Partial<StructuredJobInput> & { title: string }) =>
  normalizeJob({ job: { company: "Acme", location: "San Francisco, CA", description: "Summer 2027 internship working on our developer platform and data APIs.", ...o } });

describe("qualifyJob: qualifies the target profile", () => {
  it("qualifies a Summer 2027 PM internship in a target city", () => {
    const r = qualifyJob(job({ title: "Product Management Intern (Summer 2027)" }), prefs(), NOW);
    expect(r.decision).toBe("qualify");
    expect(r.targetRole).toBe("Product Management");
    expect(r.hardRejects).toEqual([]);
    expect(r.score).toBeGreaterThanOrEqual(55);
    expect(r.breakdown.season).toBe(100);
  });

  it("accepts remote and fellowships", () => {
    const r = qualifyJob(job({ title: "Growth Strategy Fellow", location: "Remote (US)" }), prefs(), NOW);
    expect(r.decision).toBe("qualify");
  });

  it("needs review when the location is unknown", () => {
    const r = qualifyJob(job({ title: "Product Marketing Intern", location: undefined }), prefs(), NOW);
    expect(r.decision).toBe("needs_review");
  });

  it("manual imports with no matching role need review instead of being archived", () => {
    const n = job({ title: "Marketing Associate Intern" });
    expect(qualifyJob(n, prefs(), NOW).decision).toBe("archive");
    expect(qualifyJob(n, prefs(), NOW, { manual: true }).decision).toBe("needs_review");
  });
});

describe("qualifyJob: each hard reject", () => {
  const rejects = (o: Parameters<typeof job>[0], p = prefs()) => qualifyJob(job(o), p, NOW);

  it("not an internship or fellowship", () => {
    const r = rejects({ title: "Product Manager" , description: "Full-time role." });
    expect(r.decision).toBe("archive");
    expect(r.hardRejects).toContain("not an internship or fellowship");
  });
  it("other season/year", () => {
    const r = rejects({ title: "Product Management Intern (Winter 2027)", description: "Winter 2027 program." });
    expect(r.hardRejects).toContain("targets a season other than Summer 2027");
    const old = rejects({ title: "Strategy Intern, Summer 2026", description: "Summer 2026." });
    expect(old.decision).toBe("archive");
  });
  it("expired deadline", () => {
    const r = rejects({ title: "Product Marketing Intern", deadline: "2026-10-01" });
    expect(r.hardRejects.some((h) => h.startsWith("application deadline passed"))).toBe(true);
    expect(r.priority).toBe(0);
  });
  it("military-transition programs", () => {
    const r = rejects({ title: "NextStay Fellow, Tech Ops & Programs", description: "For active duty service members separating within 180 days." });
    expect(r.hardRejects).toContain("military-transition program");
    expect(r.decision).toBe("archive");
  });
  it("engineering / design / research titles", () => {
    expect(rejects({ title: "Software Engineer Intern, Platform" }).hardRejects).toContain("engineering, design or research role");
    expect(rejects({ title: "Product Design Intern" }).hardRejects).toContain("engineering, design or research role");
    expect(rejects({ title: "Research Operations Intern" }).hardRejects).toContain("engineering, design or research role");
  });
  it("technical product management is NOT excluded", () => {
    expect(rejects({ title: "Technical Product Manager Intern (Summer 2027)" }).decision).toBe("qualify");
  });
  it("excluded company from preferences", () => {
    const r = rejects({ title: "Product Management Intern", company: "Acme Robotics" }, prefs({ excludedCompanies: ["acme"] }));
    expect(r.hardRejects).toContain("excluded company");
  });
  it("excluded location from preferences", () => {
    const r = rejects({ title: "Product Management Intern", location: "New York, NY" }, prefs({ locationsExcluded: ["new york"] }));
    expect(r.hardRejects).toContain("excluded location");
  });
  it("outside target locations", () => {
    const r = rejects({ title: "Product Management Intern", location: "Seattle, WA" });
    expect(r.hardRejects).toContain("outside target locations (Remote, TX, NY, CA, FL)");
  });
  it("preferred extra locations are accepted", () => {
    expect(rejects({ title: "Product Management Intern", location: "Seattle, WA" }, prefs({ locationsPreferred: ["seattle"] })).hardRejects).toEqual([]);
  });
  it("pay below the stated minimum (only when pay is stated)", () => {
    const r = rejects({ title: "Product Management Intern", salaryMin: 20, salaryMax: 20 }, prefs({ minHourlyUsd: 30 }));
    expect(r.hardRejects).toContain("pay below minimum ($20/hr)");
    expect(rejects({ title: "Product Management Intern" }, prefs({ minHourlyUsd: 30 })).hardRejects).toEqual([]);
  });
});

describe("deadline priority", () => {
  it("sooner deadline = higher priority, same score", () => {
    const soon = qualifyJob(job({ title: "Product Management Intern", deadline: "2026-11-09" }), prefs(), NOW);
    const later = qualifyJob(job({ title: "Product Management Intern", deadline: "2026-12-20" }), prefs(), NOW);
    const none = qualifyJob(job({ title: "Product Management Intern" }), prefs(), NOW);
    expect(soon.score).toBe(later.score);
    expect(soon.priority).toBeGreaterThan(later.priority);
    expect(later.priority).toBeGreaterThan(none.priority);
  });
  it("bands", () => {
    expect(deadlinePriority("2026-11-08", NOW)).toBe(100);
    expect(deadlinePriority("2026-11-12", NOW)).toBe(80);
    expect(deadlinePriority("2026-11-20", NOW)).toBe(60);
    expect(deadlinePriority("2026-12-05", NOW)).toBe(40);
    expect(deadlinePriority("2027-03-01", NOW)).toBe(20);
    expect(deadlinePriority(null, NOW)).toBe(10);
    expect(deadlinePriority("2026-11-01", NOW)).toBe(0);
    expect(isExpired("2026-11-07", NOW)).toBe(false); // deadline day itself is still open
    expect(isExpired("2026-11-06", NOW)).toBe(true);
  });
});

describe("filters", () => {
  it("matches each target role", () => {
    const cases: Array<[string, string]> = [
      ["Product Management Intern", "Product Management"], ["Associate Product Manager Intern", "Product Management"],
      ["Product Marketing Intern", "Product Marketing"], ["GTM Strategy Intern", "Go-to-Market Strategy"],
      ["Founder's Office Intern", "Founder's Office"], ["Chief of Staff Intern", "Founder's Office"],
      ["Business Operations Intern", "Business Operations"], ["Corporate Strategy Intern", "Corporate Strategy"],
      ["Growth Strategy Intern", "Growth Strategy"], ["Brand Management Intern", "Brand Management"],
      ["Strategic Partnerships Intern", "Strategic Partnerships"], ["AI Strategy Intern", "AI Strategy"],
      ["Portfolio Operations Intern", "VC/PE Portfolio Operations"], ["Search Fund Intern", "Search Funds"],
    ];
    for (const [title, label] of cases) expect(matchTargetRole(title)?.label, title).toBe(label);
    expect(matchTargetRole("Barista")).toBeNull();
    expect(matchTargetRole("Operations Intern")?.strength).toBe(80);
  });
  it("titleMatches requires an intern/fellow word and a target role", () => {
    expect(titleMatches("Product Marketing Intern")).toBe(true);
    expect(titleMatches("Product Marketing Manager")).toBe(false);
    expect(titleMatches("Software Engineer Intern")).toBe(false);
    expect(titleMatches("NextStay Fellow, Strategic Partnerships")).toBe(false);
  });
  it("seasonOk", () => {
    expect(seasonOk("Summer 2027 internship")).toBe(true);
    expect(seasonOk("Join us this winter 2027")).toBe(false);
    expect(seasonOk("Summer 2026 program")).toBe(false);
    expect(seasonOk("An internship")).toBe(true);
    expect(seasonOk("Summer 2026 and Summer 2027 cohorts")).toBe(true);
  });
  it("locationOk", () => {
    expect(locationOk("Remote - US")).toBe(true);
    expect(locationOk("Remote - Canada")).toBe(false);
    expect(locationOk("Austin, TX")).toBe(true);
    expect(locationOk("Miami, FL")).toBe(true);
    expect(locationOk("London, UK")).toBe(false);
  });
});
