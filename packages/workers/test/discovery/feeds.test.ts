import { describe, expect, it } from "vitest";
import { createFeedAdapter, createRemoteFeedAdapter, createRemotiveAdapter, createRemoteOkAdapter } from "../../src/discovery/index.js";

const CTX = { tenantId: "t", userId: "u" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("greenhouse feed adapter", () => {
  const list = {
    jobs: [
      { id: 111, title: "Product Management Intern (Summer 2027)", location: { name: "San Francisco, CA" }, absolute_url: "https://job-boards.greenhouse.io/acme/jobs/111", updated_at: "2026-11-01" },
      { id: 112, title: "Software Engineer Intern", location: { name: "San Francisco, CA" }, absolute_url: "https://job-boards.greenhouse.io/acme/jobs/112" },
      { id: 113, title: "Strategy & Operations Intern (Winter 2027)", location: { name: "New York, NY" }, absolute_url: "https://job-boards.greenhouse.io/acme/jobs/113" },
      { id: 114, title: "Business Operations Intern", location: { name: "London, UK" }, absolute_url: "https://job-boards.greenhouse.io/acme/jobs/114" },
      { id: 115, title: "Product Marketing Manager", location: { name: "San Francisco, CA" }, absolute_url: "https://job-boards.greenhouse.io/acme/jobs/115" },
    ],
  };
  it("lists without bodies, fetches detail only for title+location matches, then applies the season check", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.endsWith("/boards/acme/jobs")) return json(list);
      if (url.endsWith("/jobs/111")) return json({ content: "&lt;p&gt;Summer 2027 internship. Work on our API platform.&lt;/p&gt;" });
      if (url.endsWith("/jobs/113")) return json({ content: "&lt;p&gt;Winter 2027 program.&lt;/p&gt;" });
      return json({}, 404);
    }) as unknown as typeof fetch;

    const r = await createFeedAdapter("greenhouse", { boards: [{ board: "acme", name: "Acme" }], fetchImpl }).run(CTX);
    expect(r.error).toBeUndefined();
    expect(r.jobs.map((j) => j.job.title)).toEqual(["Product Management Intern (Summer 2027)"]);
    expect(r.jobs[0]!.job.company).toBe("Acme");
    expect(r.jobs[0]!.job.description).toContain("Summer 2027 internship");
    expect(r.jobs[0]!.canonicalUrl).toBe("https://job-boards.greenhouse.io/acme/jobs/111");
    expect(r.jobs[0]!.evidence).toMatchObject({ kind: "feed", board: "acme" });
    const detail = calls.filter((c) => /\/jobs\/\d+$/.test(c)).map((c) => c.split("/").pop());
    expect(detail.sort()).toEqual(["111", "113"]);          // never the engineer, London or manager postings
    expect(calls.some((c) => c.includes("content=true"))).toBe(false);
  });

  it("one unavailable board degrades but does not hide the others; all failing reports no data + error", async () => {
    const ok = { jobs: [list.jobs[0]] };
    const fetchImpl = (async (url: string) => {
      if (url.includes("/boards/down/")) throw new Error("ECONNRESET");
      if (url.endsWith("/boards/acme/jobs")) return json(ok);
      return json({ content: "Summer 2027" });
    }) as unknown as typeof fetch;
    const partial = await createFeedAdapter("greenhouse", { boards: [{ board: "acme", name: "Acme" }, { board: "down", name: "Down Co" }], fetchImpl }).run(CTX);
    expect(partial.jobs).toHaveLength(1);
    expect(partial.error).toMatch(/1\/2 boards unavailable.*Down Co/);

    const allDown = await createFeedAdapter("greenhouse", { boards: [{ board: "down", name: "Down Co" }], fetchImpl }).run(CTX);
    expect(allDown.jobs).toEqual([]);
    expect(allDown.error).toMatch(/unavailable/);
  });

  it("treats HTTP errors as board failures, never throws", async () => {
    const fetchImpl = (async () => json({ message: "nope" }, 503)) as unknown as typeof fetch;
    const r = await createFeedAdapter("greenhouse", { boards: [{ board: "acme", name: "Acme" }], fetchImpl }).run(CTX);
    expect(r.error).toMatch(/HTTP 503/);
  });
});

describe("lever and ashby feed adapters", () => {
  it("lever: uses descriptions from the list and the season check", async () => {
    const fetchImpl = (async () => json([
      { text: "Growth Strategy Intern, Summer 2027", categories: { location: "Remote - US" }, hostedUrl: "https://jobs.lever.co/acme/0a1b2c3d-1111-2222-3333-444455556666", applyUrl: "https://jobs.lever.co/acme/0a1b2c3d-1111-2222-3333-444455556666/apply", descriptionPlain: "Summer 2027 internship." },
      { text: "Growth Strategy Intern, Summer 2026", categories: { location: "Remote - US" }, hostedUrl: "https://jobs.lever.co/acme/ffffffff-1111-2222-3333-444455556666", descriptionPlain: "Summer 2026." },
    ])) as unknown as typeof fetch;
    const r = await createFeedAdapter("lever", { boards: [{ board: "acme", name: "Acme" }], fetchImpl }).run(CTX);
    expect(r.jobs.map((j) => j.job.title)).toEqual(["Growth Strategy Intern, Summer 2027"]);
    expect(r.jobs[0]!.source).toBe("lever");
  });

  it("ashby: unlisted postings are ignored", async () => {
    const fetchImpl = (async () => json({ jobs: [
      { title: "Product Marketing Intern", location: "New York, NY", jobUrl: "https://jobs.ashbyhq.com/acme/0a1b2c3d-aaaa-bbbb-cccc-ddddeeeeffff", descriptionPlain: "Summer 2027 role.", isListed: true },
      { title: "Brand Management Intern", location: "New York, NY", jobUrl: "https://jobs.ashbyhq.com/acme/9a1b2c3d-aaaa-bbbb-cccc-ddddeeeeffff", descriptionPlain: "Summer 2027.", isListed: false },
    ] })) as unknown as typeof fetch;
    const r = await createFeedAdapter("ashby", { boards: [{ board: "acme", name: "Acme" }], fetchImpl }).run(CTX);
    expect(r.jobs.map((j) => j.job.title)).toEqual(["Product Marketing Intern"]);
  });

  it("respects limit", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ title: `Product Marketing Intern ${i}`, location: "New York, NY", jobUrl: `https://jobs.ashbyhq.com/acme/0a1b2c3d-aaaa-bbbb-cccc-00000000000${i}`, descriptionPlain: "Summer 2027", isListed: true }));
    const fetchImpl = (async () => json({ jobs: many })) as unknown as typeof fetch;
    const r = await createFeedAdapter("ashby", { boards: [{ board: "acme", name: "Acme" }], fetchImpl }).run(CTX, { limit: 2 });
    expect(r.jobs).toHaveLength(2);
  });
});

describe("remote feeds", () => {
  const remotive = { jobs: [
    { id: 1, title: "Growth Strategy Intern (Summer 2027)", company_name: "RemCo", candidate_required_location: "USA", url: "https://remotive.com/remote-jobs/marketing/growth-1", description: "<p>Summer 2027</p>", publication_date: "2026-11-02" },
    { id: 2, title: "Growth Strategy Intern", company_name: "EuroCo", candidate_required_location: "Germany", url: "https://remotive.com/remote-jobs/x/2", description: "Summer 2027" },
    { id: 3, title: "Product Marketing Manager", company_name: "RemCo", candidate_required_location: "Worldwide", url: "https://remotive.com/remote-jobs/x/3", description: "" },
  ] };
  const remoteok = [
    { legal: "terms" },
    { id: "9", position: "Product Management Intern", company: "OkCo", location: "Worldwide", url: "https://remoteok.com/remote-jobs/9", description: "<p>Summer 2027 role</p>", date: "2026-11-03" },
    { id: "10", position: "Software Engineer Intern", company: "OkCo", location: "Worldwide", url: "https://remoteok.com/remote-jobs/10", description: "" },
  ];
  it("keeps only internships/fellowships in target roles and non-foreign-only locations", async () => {
    const fetchImpl = (async (url: string) => (url.includes("remotive") ? json(remotive) : json(remoteok))) as unknown as typeof fetch;
    const a = await createRemotiveAdapter({ fetchImpl }).run(CTX);
    expect(a.jobs.map((j) => j.job.company)).toEqual(["RemCo"]);
    expect(a.jobs[0]!.job.description).toBe("Summer 2027");
    const b = await createRemoteOkAdapter({ fetchImpl }).run(CTX);
    expect(b.jobs.map((j) => j.job.title)).toEqual(["Product Management Intern"]);
    const both = await createRemoteFeedAdapter({ fetchImpl }).run(CTX);
    expect(both.jobs).toHaveLength(2);
    expect(both.error).toBeUndefined();
  });
  it("one feed down degrades the combined source, keeps the other's jobs", async () => {
    const fetchImpl = (async (url: string) => { if (url.includes("remoteok")) throw new Error("timeout"); return json(remotive); }) as unknown as typeof fetch;
    const r = await createRemoteFeedAdapter({ fetchImpl }).run(CTX);
    expect(r.jobs).toHaveLength(1);
    expect(r.error).toMatch(/remoteok: timeout/);
  });
});
