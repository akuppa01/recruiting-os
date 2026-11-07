import { describe, expect, it } from "vitest";
import { createCsvAdapter, createManualAdapter, createWhatsAppAdapter } from "../../src/discovery/index.js";

const CTX = { tenantId: "t", userId: "u" };

describe("manual / csv / whatsapp wrappers", () => {
  it("manual: URLs become enrichable placeholders; pasted JDs are parsed offline", async () => {
    const jd = "Product Management Intern at Acme\nLocation: Remote\nSummer 2027 internship. Apply by Dec 15, 2026.\nYou will own roadmap items for our developer platform and work across teams.";
    const r = await createManualAdapter({ urls: ["https://jobs.lever.co/acme/0a1b2c3d-1111-2222-3333-444455556666?utm_source=x", "not a url"], texts: [jd, "too short"] }).run(CTX);
    expect(r.source).toBe("manual");
    expect(r.jobs).toHaveLength(2);
    const url = r.jobs.find((j) => j.job.applyUrl)!;
    expect(url.canonicalUrl).toBe("https://jobs.lever.co/acme/0a1b2c3d-1111-2222-3333-444455556666");
    expect(url.job.company).toBe("Unknown company");
    const text = r.jobs.find((j) => !j.job.applyUrl)!;
    expect(text.job.title).toContain("Product Management Intern");
    expect(text.evidence.kind).toBe("manual");
  });

  it("csv: structured rows, url-only rows, and skipped rows reported as a note", async () => {
    const csv = [
      "Title,Company,URL,Location",
      "Strategy Intern,Globex,https://boards.greenhouse.io/globex/jobs/123456?gh_src=abc,New York NY",
      ",,https://jobs.ashbyhq.com/initech/0a1b2c3d-aaaa-bbbb-cccc-ddddeeeeffff,",
      "Orphan,,,",
    ].join("\n");
    const r = await createCsvAdapter(csv).run(CTX);
    expect(r.jobs).toHaveLength(2);
    expect(r.jobs[0]!.job).toMatchObject({ title: "Strategy Intern", company: "Globex" });
    expect(r.jobs[0]!.canonicalUrl).toBe("https://boards.greenhouse.io/globex/jobs/123456");
    expect(r.error).toMatch(/row 4/);                 // skipped row surfaced, not silently dropped
  });

  it("whatsapp: only job-looking links, deduped", async () => {
    const chat = [
      "11/05/2026, 9:14 AM - Priya: Check this out https://jobs.lever.co/acme/0a1b2c3d-1111-2222-3333-444455556666 looks great",
      "11/05/2026, 9:15 AM - Sam: lol https://youtu.be/xyz",
      "11/05/2026, 9:16 AM - Priya: again https://jobs.lever.co/acme/0a1b2c3d-1111-2222-3333-444455556666",
    ].join("\n");
    const r = await createWhatsAppAdapter(chat).run(CTX);
    expect(r.jobs).toHaveLength(1);
    expect(r.jobs[0]!.source).toBe("whatsapp");
    expect(r.jobs[0]!.evidence.excerpt).toContain("Priya");
  });
});
