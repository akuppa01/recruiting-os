// Real-world alert layouts (12twenty digest/single/invite, Handshake round-up/marketing, LinkedIn courses).
// Fixtures are sanitized: synthetic companies, placeholder tracking links, no personal data.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { GmailResult } from "../../src/gmail/connector.js";
import {
  createEmailAdapter, followRedirects, parseDeadline, parseHandshakeRoundup, parseTwelveTwentyEmail, splitCompanyTitle,
} from "../../src/discovery/email.js";

const CTX = { tenantId: "t", userId: "u" };
const fx = (n: string) => readFileSync(fileURLToPath(new URL(`../fixtures/emails/${n}`, import.meta.url)), "utf8");
type Mail = { from: string; subject: string; text: string; date?: string; messageId?: string };
const gmail = (emails: Mail[]): GmailResult => ({
  connected: true, listRecent: async () => emails,
  createDraft: async () => ({ draftId: "d" }), send: async () => ({ messageId: "m", threadId: "t" }),
});
const TT = "12twenty <noreply@mba-school.12twenty.com>";
const DIGEST: Mail = { from: TT, subject: "Saved Search: MBA Internships", text: fx("twelve-twenty-digest.txt"), messageId: "d1", date: "2026-11-05T10:00:00Z" };
const SINGLE: Mail = { from: TT, subject: "A new job opportunity", text: fx("twelve-twenty-single.txt"), messageId: "s1" };
const INVITE: Mail = { from: TT, subject: "You're invited", text: fx("twelve-twenty-invite.txt"), messageId: "i1" };
const HS = "Handshake <no-reply@g.joinhandshake.com>";

describe("helpers", () => {
  it("parseDeadline -> ISO date", () => {
    expect(parseDeadline("Application Deadline: Sunday, 29 November 2026 11:59PM EST")).toBe("2026-11-29");
    expect(parseDeadline("Deadline November 5, 2026")).toBe("2026-11-05");
    expect(parseDeadline("no date")).toBeUndefined();
  });
  it("splitCompanyTitle removes duplicated company", () => {
    expect(splitCompanyTitle("Acme Capital - Acme Capital - MBA Summer Associate 2027")).toEqual({ company: "Acme Capital", title: "MBA Summer Associate 2027" });
    expect(splitCompanyTitle("Globex - PM Intern")).toEqual({ company: "Globex", title: "PM Intern" });
  });
});

describe("12twenty", () => {
  it("digest: every block, wrapped title, dedup company, type, deadline, link", () => {
    const jobs = parseTwelveTwentyEmail(DIGEST);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({ company: "Acme Capital", title: "MBA Summer Associate 2027", jobType: "Internship, Job Listing", deadline: "2026-11-29" });
    expect(jobs[0]!.url).toMatch(/^https:\/\/click\.12twenty\.com\//);
    expect(jobs[1]).toMatchObject({ company: "Globex Corp", title: "Product Management Intern (MBA)", deadline: "2026-12-04" });
    expect(jobs[2]).toMatchObject({ company: "Initech", jobType: "Job Listing" });
    expect(jobs[2]!.deadline).toBeUndefined();
  });
  it("single-job email yields one job; invite yields none", () => {
    expect(parseTwelveTwentyEmail(SINGLE)).toHaveLength(1);
    expect(parseTwelveTwentyEmail(INVITE)).toHaveLength(0);
  });
  it("adapter: tracking links do not collide; jobs flagged needsEnrichment with null canonicalUrl", async () => {
    const r = await createEmailAdapter("twelve_twenty", { getGmail: () => gmail([DIGEST, SINGLE, INVITE]) }).run(CTX);
    expect(r.jobs).toHaveLength(4);
    expect(new Set(r.jobs.map((j) => j.sourceRef)).size).toBe(4);
    for (const j of r.jobs) { expect(j.canonicalUrl).toBeNull(); expect(j.needsEnrichment).toBe(true); }
    expect(r.jobs[0]!.job.deadline).toBe("2026-11-29");
    expect(r.jobs[3]!.schoolRequirements).toBeUndefined();   // single-job email has no requirement lines
    expect(r.jobs[2]!.schoolRequirements).toContain("Open to currently enrolled MBA students");
  });
  it("adapter: the same job across two digests is deduped", async () => {
    const r = await createEmailAdapter("twelve_twenty", { getGmail: () => gmail([DIGEST, { ...DIGEST, messageId: "d2" }]) }).run(CTX);
    expect(r.jobs).toHaveLength(3);
  });
  it("resolveUrl: resolved ATS link becomes canonical; failures keep the original link", async () => {
    const resolveUrl = vi.fn(async (u: string) => (u.includes("SYNTHETIC-1") ? "https://boards.greenhouse.io/acme/jobs/123?gh_src=x" : null));
    const r = await createEmailAdapter("twelve_twenty", { getGmail: () => gmail([DIGEST]), resolveUrl }).run(CTX);
    const a = r.jobs[0]!;
    expect(a.canonicalUrl).toBe("https://boards.greenhouse.io/acme/jobs/123");
    expect(a.needsEnrichment).toBeUndefined();
    const b = r.jobs[1]!;
    expect(b.canonicalUrl).toBeNull(); expect(b.needsEnrichment).toBe(true); expect(b.job.applyUrl).toMatch(/click\.12twenty\.com/);
  });
  it("resolveUrl that throws is tolerated", async () => {
    const r = await createEmailAdapter("twelve_twenty", { getGmail: () => gmail([SINGLE]), resolveUrl: async () => { throw new Error("boom"); } }).run(CTX);
    expect(r.error).toBeUndefined(); expect(r.jobs).toHaveLength(1);
  });
});

describe("handshake round-up", () => {
  const mail: Mail = { from: HS, subject: "Jobs picked for you", text: fx("handshake-roundup.txt"), messageId: "h1" };
  it("parses URL-less blocks with type, location and pay", () => {
    const jobs = parseHandshakeRoundup(mail);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({ company: "Wayne Enterprises", title: "Business Development Intern", jobType: "Internship", location: "Pittsburgh, PA", salaryMin: 45 });
    expect(jobs[1]).toMatchObject({ company: "Stark Industries", location: "Remote", salaryMin: 155000, salaryMax: 200000 });
    expect(jobs[2]).toMatchObject({ company: "Hooli", jobType: "Full-time" });
  });
  it("adapter: distinct keys, no URL, null canonicalUrl; marketing email yields nothing", async () => {
    const marketing: Mail = { from: HS, subject: "Career fair", text: fx("handshake-marketing.txt"), messageId: "h2" };
    const r = await createEmailAdapter("handshake", { getGmail: () => gmail([mail, marketing]) }).run(CTX);
    expect(r.jobs).toHaveLength(3);
    expect(new Set(r.jobs.map((j) => j.sourceRef)).size).toBe(3);
    expect(r.jobs.every((j) => j.canonicalUrl === null && !j.job.applyUrl)).toBe(true);
  });
});

describe("linkedin", () => {
  it("course email yields no jobs", async () => {
    const m: Mail = { from: "LinkedIn <news@linkedin.com>", subject: "Courses for you", text: fx("linkedin-courses.txt"), messageId: "l1" };
    const r = await createEmailAdapter("linkedin_alert", { getGmail: () => gmail([m]) }).run(CTX);
    expect(r.jobs).toHaveLength(0);
  });
});

describe("followRedirects", () => {
  it("follows hops and returns the final URL; returns null on error", async () => {
    const fetchImpl = vi.fn(async (u: string | URL | Request) => {
      const url = String(u);
      if (url === "https://a.test/x") return new Response(null, { status: 302, headers: { location: "https://b.test/y" } });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    expect(await followRedirects("https://a.test/x", { fetchImpl })).toBe("https://b.test/y");
    const bad = (async () => { throw new Error("net"); }) as unknown as typeof fetch;
    expect(await followRedirects("https://a.test/x", { fetchImpl: bad })).toBeNull();
  });
});
