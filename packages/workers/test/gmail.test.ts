import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { InMemoryStore } from "../../db/src/memory.js";
import { alertToIngestRequests, classifyInbound, createGmailConnectorFromEnv, csvToIngestRequests, gmailFromClient, handleInboundReply, parseAlertEmail, parseCsv, parseWhatsAppExport, rowsToIngestRequests, rfc822 } from "../src/gmail/index.js";
import { DryRunNotifier } from "../src/notify/index.js";
import { ctx } from "./helpers.js";
const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");

describe("alert parser", () => {
  it("LinkedIn: title/company/location + canonical URLs, non-job links ignored", () => {
    const jobs = parseAlertEmail({ from: "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>", subject: "alert", text: fx("linkedin-alert.txt") });
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ title: "Product Manager Intern, MBA", company: "Acme AI", location: "New York, NY", url: "https://www.linkedin.com/jobs/view/3912345678", source: "linkedin_alert" });
    expect(jobs[1]).toMatchObject({ company: "Globex", location: "Remote" });
  });
  it("Handshake + ATS link; falls back to url-only when company unknown", () => {
    const reqs = alertToIngestRequests({ from: "no-reply@joinhandshake.com", subject: "New jobs", text: fx("handshake-alert.txt") });
    expect(reqs).toHaveLength(2);
    expect(reqs[0]!.job).toMatchObject({ title: "Product Marketing Intern", company: "Initech" });
    expect(reqs[0]!.source).toBe("handshake");
    expect(reqs[1]!.job).toBeUndefined(); expect(reqs[1]!.url).toContain("ashbyhq.com");
    expect(new Set(reqs.map((r) => r.idempotencyKey)).size).toBe(2);
  });
  it("unknown sender with no job URLs -> nothing", () => { expect(parseAlertEmail({ from: "a@b.com", subject: "hi", text: "see https://example.com" })).toEqual([]); });
});

describe("reply classifier + hooks", () => {
  it.each([
    ["Re: hi", "Please remove me from your list.", "opt_out"],
    ["Automatic reply", "I am out of office until Monday", "auto_reply"],
    ["Update", "Unfortunately we will not be moving forward with your application.", "rejection"],
    ["Re: PM intern", "Happy to chat! Can we schedule a call next week? calendly.com/x", "interview"],
    ["Re:", "Reach out to Jane on my team, I'm looping her in.", "referral"],
    ["Re:", "Thanks for the note, interesting background.", "positive_reply"],
    ["Re:", "", "unknown"],
  ])("%s -> %s", (s, b, c) => expect(classifyInbound(s, b)).toBe(c));

  it("interview reply stops the sequence, advances job, notifies urgent", async () => {
    const s = new InMemoryStore(); const n = new DryRunNotifier();
    const co = await s.upsertCompany(ctx, "Acme", null);
    const c = await s.upsertContact(ctx, { ctx, companyId: co.id, name: "J", title: "PM", email: "j@a.com", linkedinUrl: null, relevance: 1, source: "t" });
    const r = await handleInboundReply(s, ctx, n, { contactId: c.id, subject: "Re", body: "Let's schedule a call" });
    expect(r).toEqual({ class: "interview", stopped: true });
    expect((await s.listContacts(ctx, co.id))[0]!.suppressed).toBe(true);
    expect(n.sent[0]!.priority).toBe("urgent");
  });
  it("auto-reply does not suppress", async () => {
    const s = new InMemoryStore(); const co = await s.upsertCompany(ctx, "A", null);
    const c = await s.upsertContact(ctx, { ctx, companyId: co.id, name: "J", title: null, email: null, linkedinUrl: null, relevance: 1, source: "t" });
    expect((await handleInboundReply(s, ctx, new DryRunNotifier(), { contactId: c.id, subject: "Auto-reply", body: "out of office" })).stopped).toBe(false);
  });
});

describe("gmail connector", () => {
  it("explicit not-connected without creds", async () => {
    const r = await createGmailConnectorFromEnv({}); expect(r).toMatchObject({ connected: false }); expect((r as any).reason).toContain("GMAIL_REFRESH_TOKEN");
  });
  it("wraps a client; builds raw message; rejects header injection", async () => {
    const calls: any[] = [];
    const g = gmailFromClient({ users: { drafts: { create: async (a: any) => { calls.push(a); return { data: { id: "d1" } }; } }, messages: { send: async (a: any) => { calls.push(a); return { data: { id: "m1", threadId: "t1" } }; }, list: async () => ({ data: { messages: [{ id: "m1" }] } }), get: async () => ({ data: { threadId: "t1", payload: { headers: [{ name: "From", value: "x@y.com" }, { name: "Subject", value: "S" }], mimeType: "text/plain", body: { data: Buffer.from("hello").toString("base64") } } } }) } } });
    expect(await g.createDraft("a@b.com", "Hi", "Body")).toEqual({ draftId: "d1" });
    expect(await g.send("a@b.com", "Hi", "Body", "t1")).toEqual({ messageId: "m1", threadId: "t1" });
    expect((await g.listRecent("q"))[0]).toMatchObject({ from: "x@y.com", subject: "S", text: "hello" });
    expect(() => rfc822("a@b.com\nBcc: z", "s", "b")).toThrow();
  });
});

describe("ingest adapters", () => {
  it("CSV with quotes/newlines + header aliases + idempotency + skipped rows", () => {
    const csv = 'Role,Employer,Link,Notes\n"Product Intern, MBA",Acme,https://acme.com/jobs/1,x\n,,https://boards.greenhouse.io/z/jobs/9,\n,,,\nfoo,,,"line1\nline2"\n';
    expect(parseCsv(csv)).toHaveLength(4);
    const { requests, skipped } = csvToIngestRequests(csv);
    expect(requests).toHaveLength(2); expect(requests[0]!.job).toMatchObject({ title: "Product Intern, MBA", company: "Acme" }); expect(requests[1]!.url).toContain("greenhouse");
    expect(skipped).toHaveLength(1);
    expect(csvToIngestRequests(csv).requests[0]!.idempotencyKey).toBe(requests[0]!.idempotencyKey);
  });
  it("Google Sheet rows (array of arrays)", () => {
    expect(rowsToIngestRequests([["Title", "Company"], ["PM Intern", "Acme"]], "gdrive_sheet").requests[0]!.source).toBe("gdrive_sheet");
  });
  it("WhatsApp export: multiline, job URLs only, dedupes, strips punctuation", () => {
    const r = parseWhatsAppExport(fx("whatsapp.txt"));
    expect(r.map((x) => x.url)).toEqual(["https://boards.greenhouse.io/stripe/jobs/5555", "https://jobs.lever.co/palantir/0a1b2c3d-1111-2222-3333-444455556666"]);
    expect(r[0]!.note).toContain("Priya");
  });
});
