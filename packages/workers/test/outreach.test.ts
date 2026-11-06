import { describe, it, expect, vi } from "vitest";
import { AutomationPolicy, type EvidenceItem } from "@ros/core";
import {
  planSequence, draftEmail, OPT_OUT_LINE, classifyReply, runOutreachTick, scheduleSequence, createManualChannelTask,
  inQuietHours, localParts, sendOrDryRun, type EmailSender, type TickDeps,
} from "../src/outreach/index.js";
import { makeFake, ctx } from "./fakeStore.js";

const evidence: EvidenceItem[] = [
  { id: "e1", employer: "Lockheed Martin", role: "Software Engineer", dates: "2023-2025", statement: "Led CI/CD modernization across 7 teams.", metrics: ["7 teams"], tags: ["engineering", "technical"], verifiedBy: "resume", sourceDoc: "resume.pdf" },
  { id: "e2", employer: "ASVA Group", role: "Founder", dates: "2025-", statement: "Founded an AI automation agency for SMBs.", metrics: [], tags: ["product", "gtm"], verifiedBy: "resume", sourceDoc: "resume.pdf" },
];
const base = { company: "Acme", jobTitle: "Product Management Intern", contactName: "Jane Doe", candidateName: "Adi", candidateIntro: "an MBA student at Carnegie Mellon Tepper", evidence };
const ALLOWED = new Date("2026-11-10T15:00:00Z"); // 10:00 New York
const QUIET = new Date("2026-11-10T03:00:00Z");   // 22:00 New York (prev day)

const policy = (o: object = {}) => AutomationPolicy.parse({ autoOutreach: true, ...o });
function mkSender(verified = true) {
  const send = vi.fn(async () => ({ messageId: "m1", threadId: "t1" }));
  const s: EmailSender = { name: "fake", isVerified: async () => verified, send };
  return { s, send };
}
async function setup(n = 1, pol = policy()) {
  const f = makeFake();
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = await f.store.upsertContact(ctx, { companyId: "co1", name: `C${i}`, title: "PM", email: `c${i}@acme.test`, linkedinUrl: null, relevance: 50, source: "manual" });
    ids.push(c.id);
    await scheduleSequence(f.store, ctx, { ...base, contactName: `C${i}`, contactId: c.id, jobId: "j1" }, pol, ALLOWED);
  }
  const deps = (sender: EmailSender, p = pol, extra: Partial<TickDeps> = {}): TickDeps => ({
    policy: p, sender, fromAddress: "me@x.test", lookupContact: async (id) => { const c = f.contacts.get(id); return c ? { id, email: c.email, suppressed: c.suppressed, name: c.name } : null; }, ...extra,
  });
  return { f, ids, deps };
}

describe("planning", () => {
  it("step 0 + follow-ups on policy days, none in quiet hours", () => {
    const p = policy();
    const plan = planSequence(QUIET, p);
    expect(plan.map((x) => x.step)).toEqual([0, 1, 2, 3]);
    for (const s of plan) expect(inQuietHours(new Date(s.scheduledFor), p.quietHours)).toBe(false);
    expect(localParts(new Date(plan[0]!.scheduledFor), "America/New_York").hour).toBe(7);
    const gap = (new Date(plan[1]!.scheduledFor).getTime() - new Date(plan[0]!.scheduledFor).getTime()) / 86_400_000;
    expect(gap).toBeGreaterThanOrEqual(4 - 1e-9);
  });
});

describe("drafting", () => {
  it("refuses without evidence", () => expect(() => draftEmail({ ...base, evidence: [], step: 0 })).toThrow(/evidence/i));
  it("uses evidence statements verbatim, includes opt-out, no proof link unless given", () => {
    const d = draftEmail({ ...base, step: 0 });
    expect(d.body).toContain("Founded an AI automation agency for SMBs.");
    expect(d.body).toContain(OPT_OUT_LINE);
    expect(d.body).not.toMatch(/https?:\/\//);
    expect(d.evidenceIds.every((id) => evidence.some((e) => e.id === id))).toBe(true);
    expect(draftEmail({ ...base, step: 0, proofUrl: "https://p.test/x" }).body).toContain("https://p.test/x");
  });
  it("follow-ups carry opt-out and no new claims", () => {
    for (const step of [1, 2]) { const d = draftEmail({ ...base, step }); expect(d.body).toContain(OPT_OUT_LINE); expect(d.body).not.toContain("Led CI/CD"); }
  });
});

describe("reply classification", () => {
  it.each([
    ["Please unsubscribe me", "opt_out"], ["we are not hiring right now", "rejection"], ["Out of office until Monday", "auto_reply"],
    ["Sure, happy to chat Thursday!", "reply"],
  ])("%s -> %s", (t, k) => expect(classifyReply(t)).toBe(k));
  it("bounce", () => expect(classifyReply("550 5.1.1 address not found", "MAILER-DAEMON")).toBe("bounce"));
});

describe("runOutreachTick", () => {
  it("dry-run never calls sender.send; marks dry_run; idempotent", async () => {
    const { f, deps } = await setup(1, policy({ mode: "dry_run" }));
    const { s, send } = mkSender();
    const r1 = await runOutreachTick(f.store, ctx, ALLOWED, deps(s, policy({ mode: "dry_run" })));
    expect(r1.dryRun).toBe(1); expect(send).not.toHaveBeenCalled();
    expect(f.actions.every((a) => a.status === "dry_run")).toBe(true);
    const r2 = await runOutreachTick(f.store, ctx, ALLOWED, deps(s, policy({ mode: "dry_run" })));
    expect(r2.dryRun + r2.sent).toBe(0);
  });
  it("live + verified sends once; records succeeded", async () => {
    const p = policy({ mode: "live" });
    const { f, deps } = await setup(1, p);
    const { s, send } = mkSender(true);
    const r = await runOutreachTick(f.store, ctx, ALLOWED, deps(s, p));
    expect(r.sent).toBe(1); expect(send).toHaveBeenCalledTimes(1);
    await runOutreachTick(f.store, ctx, ALLOWED, deps(s, p));
    expect(send).toHaveBeenCalledTimes(1);
    expect(f.actions[0]).toMatchObject({ status: "succeeded" });
  });
  it("live but unverified connection: nothing sent, exception raised, rows stay scheduled", async () => {
    const p = policy({ mode: "live" });
    const { f, deps } = await setup(1, p);
    const { s, send } = mkSender(false);
    const r = await runOutreachTick(f.store, ctx, ALLOWED, deps(s, p));
    expect(r.blocked).toBe(1); expect(send).not.toHaveBeenCalled();
    expect(f.exceptions[0].type).toBe("integration_not_connected");
    expect([...f.outreach.values()].find((o) => o.step === 0).status).toBe("scheduled");
  });
  it("autoOutreach=false leaves drafts untouched", async () => {
    const p = policy({ autoOutreach: false, mode: "live" });
    const { f, deps } = await setup(1, p);
    const { s, send } = mkSender();
    const r = await runOutreachTick(f.store, ctx, ALLOWED, deps(s, p));
    expect(r.sent + r.dryRun).toBe(0); expect(send).not.toHaveBeenCalled();
  });
  it("a reply suppresses the contact and stops all later follow-ups", async () => {
    const p = policy({ mode: "live" });
    const { f, deps, ids } = await setup(1, p);
    const { s, send } = mkSender();
    await runOutreachTick(f.store, ctx, ALLOWED, deps(s, p));
    expect(send).toHaveBeenCalledTimes(1);
    const later = new Date(ALLOWED.getTime() + 5 * 86_400_000); // follow-up 1 is due
    const r = await runOutreachTick(f.store, ctx, later, deps(s, p, { checkInbound: async () => [{ text: "Thanks, let's talk next week!" }] }));
    expect(r.inbound).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(f.contacts.get(ids[0]!).suppressed).toBe(true);
    const pending = [...f.outreach.values()].filter((o) => o.status === "scheduled");
    expect(pending).toEqual([]);
    // even much later, nothing goes out
    await runOutreachTick(f.store, ctx, new Date(ALLOWED.getTime() + 30 * 86_400_000), deps(s, p));
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("opt-out/auto-reply handling: auto-reply does not suppress", async () => {
    const p = policy({ mode: "live" });
    const { f, deps, ids } = await setup(1, p);
    const { s } = mkSender();
    await runOutreachTick(f.store, ctx, ALLOWED, deps(s, p));
    await runOutreachTick(f.store, ctx, new Date(ALLOWED.getTime() + 5 * 86_400_000), deps(s, p, { checkInbound: async () => [{ text: "Automatic reply: out of office" }] }));
    expect(f.contacts.get(ids[0]!).suppressed).toBe(false);
  });
  it("respects quiet hours (defers, does not send)", async () => {
    const { f, deps } = await setup(1);
    const { s, send } = mkSender();
    const lateNight = new Date("2026-11-11T03:00:00Z"); // 22:00 New York; step 0 (10:00 on 11-10) is already due
    const r = await runOutreachTick(f.store, ctx, lateNight, deps(s, policy({ mode: "live" })));
    expect(r.skippedQuiet).toBe(1); expect(r.sent + r.dryRun).toBe(0);
    const row = [...f.outreach.values()].find((o) => o.step === 0);
    expect(row.status).toBe("scheduled");
    expect(inQuietHours(new Date(row.scheduledFor), policy().quietHours)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
  it("enforces daily cap and defers the rest", async () => {
    const p = policy({ mode: "dry_run", maxOutreachPerDay: 2 });
    const { f, deps } = await setup(3, p);
    const { s } = mkSender();
    const r = await runOutreachTick(f.store, ctx, ALLOWED, deps(s, p));
    expect(r.dryRun).toBe(2); expect(r.skippedCap).toBe(1);
    const r2 = await runOutreachTick(f.store, ctx, ALLOWED, deps(s, p));
    expect(r2.dryRun).toBe(0);
  });
  it("scheduleSequence is idempotent", async () => {
    const { f, ids } = await setup(1);
    const again = await scheduleSequence(f.store, ctx, { ...base, contactId: ids[0]!, jobId: "j1" }, policy(), ALLOWED);
    expect(again.length).toBe(4); expect(f.outreach.size).toBe(4);
  });
});

describe("misc", () => {
  it("sendOrDryRun: dry-run mode never touches sender", async () => {
    const { s, send } = mkSender();
    expect((await sendOrDryRun({ mode: "dry_run", autoOutreach: true }, s, { to: "a", from: "b", subject: "s", body: "b" })).status).toBe("dry_run");
    expect(send).not.toHaveBeenCalled();
  });
  it("LinkedIn/X become manual exception tasks", async () => {
    const f = makeFake();
    await createManualChannelTask(f.store, ctx, { channel: "linkedin", contactId: "c1", contactName: "Jane", draft: "Hi Jane" });
    expect(f.exceptions[0]).toMatchObject({ type: "platform_restricts_automation" });
    expect(f.exceptions[0].detail).toContain("Hi Jane");
  });
});
