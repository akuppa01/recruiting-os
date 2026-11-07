import { describe, expect, it } from "vitest";
import type { DiscoveredJob, SourceAdapter } from "@ros/core";
import { runDiscovery } from "../../src/discovery/index.js";

const CTX = { tenantId: "t", userId: "u" };
const TRACK = "https://click.12twenty.com/ls/click?upn=u001.abc";

const emailJob = (company: string, title: string, o: Partial<DiscoveredJob> = {}): DiscoveredJob => ({
  source: "twelve_twenty", sourceRef: `twelve_twenty:${company}|${title}`, canonicalUrl: null,
  job: { title, company, location: "Remote", applyUrl: `${TRACK}${company}`, sourceUrl: `${TRACK}${company}` },
  evidence: { kind: "email" }, needsEnrichment: true, ...o,
});
const adapterOf = (jobs: DiscoveredJob[]): SourceAdapter => ({ id: "twelve_twenty", kind: "email", run: async () => ({ source: "twelve_twenty", jobs }) });

describe("runDiscovery with unresolved email tracking links", () => {
  it("keeps distinct jobs whose apply links are all tracking redirects (regression: all collapsed into one)", async () => {
    // Every click.12twenty.com link canonicalizes to the same address, so the URL must not act as identity.
    const r = await runDiscovery(CTX, { adapters: [adapterOf([emailJob("Acme", "PM Intern"), emailJob("Globex", "Strategy Intern"), emailJob("Initech", "Product Intern")])] });
    expect(r.jobs.map((j) => j.job.company).sort()).toEqual(["Acme", "Globex", "Initech"]);
    expect(r.duplicatesDropped).toBe(0);
    expect(r.jobs.every((j) => j.canonicalUrl === null)).toBe(true);
  });

  it("still dedupes the same company/title/location seen twice", async () => {
    const r = await runDiscovery(CTX, { adapters: [adapterOf([emailJob("Acme", "PM Intern"), emailJob("Acme", "PM Intern")])] });
    expect(r.jobs).toHaveLength(1);
    expect(r.duplicatesDropped).toBe(1);
  });

  it("still dedupes resolved URLs", async () => {
    const u = "https://boards.greenhouse.io/acme/jobs/1";
    const a = emailJob("Acme", "PM Intern", { canonicalUrl: u, needsEnrichment: false });
    const b = { ...a, source: "greenhouse" as const, sourceRef: "gh:1", job: { ...a.job, company: "Acme Inc" } };
    const r = await runDiscovery(CTX, { adapters: [adapterOf([a, b])] });
    expect(r.jobs).toHaveLength(1);
  });
});
