import { describe, expect, it } from "vitest";
import type { GmailResult } from "../../src/gmail/connector.js";
import { createEmailAdapter, extractSchoolRequirements, parseIndeedEmail, buildAdapters } from "../../src/discovery/index.js";

const CTX = { tenantId: "t", userId: "u" };
type Mail = { from: string; subject: string; text: string; date?: string; messageId?: string };
const gmail = (emails: Mail[]): GmailResult => ({
  connected: true,
  listRecent: async () => emails,
  createDraft: async () => ({ draftId: "d" }),
  send: async () => ({ messageId: "m", threadId: "t" }),
});

const HANDSHAKE: Mail = {
  from: "Handshake <no-reply@joinhandshake.com>", subject: "New jobs matching your saved search", date: "2026-11-05T10:00:00Z", messageId: "hs-1",
  text: [
    "Product Management Intern - Summer 2027", "Acme Corp · San Francisco, CA", "https://cmu.joinhandshake.com/stu/jobs/9876543?ref=email", "",
    "Eligibility: Open to MBA candidates graduating in 2028 only.", "Must be currently enrolled at Carnegie Mellon University.", "Work authorization required; no sponsorship available.",
    "", "Unsubscribe",
  ].join("\n"),
};
const TWELVE: Mail = {
  from: "12twenty <alerts@12twenty.com>", subject: "New postings for you", date: "2026-11-05T11:00:00Z", messageId: "tt-1",
  text: ["Strategy & Operations Intern", "Globex · New York, NY", "https://tepper.12twenty.com/students/job-posting/4455", "", "Requirement: Tepper MBA Class of 2028 students only."].join("\n"),
};
const LINKEDIN: Mail = {
  from: "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>", subject: "Product Marketing Intern: new jobs", date: "2026-11-06T09:00:00Z", messageId: "li-1",
  text: ["Product Marketing Intern", "Initech · Austin, TX", "https://www.linkedin.com/comm/jobs/view/4012345678?trackingId=abc&refId=xyz", ""].join("\n"),
};
const INDEED: Mail = {
  from: "Indeed <alert@indeed.com>", subject: "Growth Strategy Intern jobs", date: "2026-11-06T08:00:00Z", messageId: "in-1",
  text: ["New jobs for you", "Growth Strategy Intern (Summer 2027)", "Umbrella Inc", "Miami, FL", "https://www.indeed.com/rc/clk?jk=abc123def4567890&fccid=1&vjs=3", "",
    "Some wrapped ad", "https://www.indeed.com/pagead/clk?mo=r&ad=-6NYlbfk"].join("\n"),
};

describe("email adapters", () => {
  it("handshake: parses jobs and preserves school-specific requirements verbatim", async () => {
    const r = await createEmailAdapter("handshake", { getGmail: () => gmail([HANDSHAKE, LINKEDIN]) }).run(CTX);
    expect(r.error).toBeUndefined();
    expect(r.jobs).toHaveLength(1);                            // LinkedIn email ignored by the Handshake adapter
    const j = r.jobs[0]!;
    expect(j.source).toBe("handshake");
    expect(j.job).toMatchObject({ title: "Product Management Intern - Summer 2027", company: "Acme Corp", location: "San Francisco, CA" });
    expect(j.canonicalUrl).toBe("https://cmu.joinhandshake.com/stu/jobs/9876543");
    expect(j.schoolRequirements).toContain("Eligibility: Open to MBA candidates graduating in 2028 only.");
    expect(j.schoolRequirements).toContain("Must be currently enrolled at Carnegie Mellon University.");
    expect(j.evidence).toMatchObject({ kind: "email", receivedAt: "2026-11-05T10:00:00Z" });
    expect(j.sourceRef).toBe("hs-1");
  });

  it("12twenty: parses jobs and keeps the school's requirement text", async () => {
    const r = await createEmailAdapter("twelve_twenty", { getGmail: () => gmail([TWELVE]) }).run(CTX);
    expect(r.jobs).toHaveLength(1);
    expect(r.jobs[0]!.job.company).toBe("Globex");
    expect(r.jobs[0]!.schoolRequirements).toBe("Requirement: Tepper MBA Class of 2028 students only.");
  });

  it("linkedin: canonicalizes the wrapper URL; no school requirements", async () => {
    const r = await createEmailAdapter("linkedin_alert", { getGmail: () => gmail([LINKEDIN]) }).run(CTX);
    expect(r.jobs).toHaveLength(1);
    expect(r.jobs[0]!.canonicalUrl).toBe("https://www.linkedin.com/jobs/view/4012345678");
    expect(r.jobs[0]!.schoolRequirements).toBeUndefined();
    expect(r.jobs[0]!.job).toMatchObject({ title: "Product Marketing Intern", company: "Initech", location: "Austin, TX" });
  });

  it("indeed: resolves jk links, skips unresolvable ad-click wrappers", async () => {
    const r = await createEmailAdapter("indeed_alert", { getGmail: () => gmail([INDEED]) }).run(CTX);
    expect(r.jobs).toHaveLength(1);
    const j = r.jobs[0]!;
    expect(j.canonicalUrl).toBe("https://www.indeed.com/viewjob?jk=abc123def4567890");
    expect(j.job).toMatchObject({ title: "Growth Strategy Intern (Summer 2027)", company: "Umbrella Inc", location: "Miami, FL" });
    expect(parseIndeedEmail(INDEED)).toHaveLength(1);
  });

  it("reports notConfigured (never fake data) when Gmail isn't connected", async () => {
    const r = await createEmailAdapter("handshake", { getGmail: () => ({ connected: false, reason: "no OAuth credentials" }) }).run(CTX);
    expect(r.jobs).toEqual([]);
    expect(r.notConfigured).toMatch(/not connected.*no OAuth credentials/i);
    expect(r.error).toBeUndefined();
  });

  it("gmail failures become errors, not exceptions", async () => {
    const bad: GmailResult = { ...(gmail([]) as Extract<GmailResult, { connected: true }>), listRecent: async () => { throw new Error("quota exceeded"); } };
    const r = await createEmailAdapter("handshake", { getGmail: () => bad }).run(CTX);
    expect(r.error).toMatch(/quota exceeded/);
    const thrown = await createEmailAdapter("handshake", { getGmail: () => { throw new Error("token revoked"); } }).run(CTX);
    expect(thrown.error).toMatch(/token revoked/);
  });

  it("flags jobs whose title/company could not be read so downstream enrichment can resolve them", async () => {
    const m: Mail = { from: "no-reply@joinhandshake.com", subject: "Job alert", text: "https://app.joinhandshake.com/jobs/777\n", messageId: "x" };
    const r = await createEmailAdapter("handshake", { getGmail: () => gmail([m]) }).run(CTX);
    expect(r.jobs[0]!.job).toMatchObject({ title: "Untitled role", company: "Unknown company" });
    expect(r.jobs[0]!.evidence.excerpt).toMatch(/unresolved/);
  });

  it("honors since", async () => {
    const r = await createEmailAdapter("handshake", { getGmail: () => gmail([HANDSHAKE]) }).run(CTX, { since: "2026-11-06T00:00:00Z" });
    expect(r.jobs).toHaveLength(0);
  });
});

describe("extractSchoolRequirements", () => {
  it("keeps only requirement-bearing lines, verbatim, ignoring bare URLs", () => {
    const t = "Hello\nhttps://x.com/eligibility\nOpen to all students who are currently enrolled in an MBA program.\nUnsubscribe";
    expect(extractSchoolRequirements(t)).toBe("Open to all students who are currently enrolled in an MBA program.");
    expect(extractSchoolRequirements("nothing relevant here at all")).toBeUndefined();
  });
});

describe("buildAdapters", () => {
  it("builds feeds only for provided boards, all four email sources, and remote; defaults Gmail to notConfigured", async () => {
    const adapters = buildAdapters({ boards: { greenhouse: [{ board: "a", name: "A" }], ashby: [] } });
    expect(adapters.map((a) => a.id)).toEqual(["greenhouse", "handshake", "twelve_twenty", "linkedin_alert", "indeed_alert", "remote_feed"]);
    const email = adapters.find((a) => a.id === "handshake")!;
    expect((await email.run(CTX)).notConfigured).toBeTruthy();
    expect(buildAdapters({ boards: { greenhouse: [{ board: "a", name: "A" }] }, only: ["greenhouse"] }).map((a) => a.id)).toEqual(["greenhouse"]);
  });
});
