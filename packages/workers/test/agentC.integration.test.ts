// Agent C flows against the real InMemoryStore from @ros/db (not the local fake).
import { describe, it, expect } from "vitest";
import { AutomationPolicy, type EvidenceItem, type NormalizedJob } from "@ros/core";
import { InMemoryStore } from "@ros/db";
import { runResearchStage, discoverContacts, ManualProvider, scheduleSequence, runOutreachTick, writeProofPage, type EmailSender } from "../src/index.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ctx = { tenantId: "t1", userId: "u1" };
const evidence: EvidenceItem[] = [{ id: "e1", employer: "ASVA", role: "Founder", dates: "2025-", statement: "Founded an AI automation agency for SMBs.", metrics: [], tags: ["gtm"], verifiedBy: "resume", sourceDoc: "r.pdf" }];

describe("Agent C on InMemoryStore", () => {
  it("research stage -> proof page -> contacts -> outreach -> reply suppresses", async () => {
    const store = new InMemoryStore();
    const ing = await store.createIngestion(ctx, { source: "manual_text", text: "x" } as any);
    const norm = { title: "GTM Intern", company: "Acme", companyDomain: "acme.test", location: null, remote: null, description: "gtm strategy", applyUrl: null, sourceUrl: null, atsKind: "unknown", atsJobId: null, salaryMin: null, salaryMax: null, salaryCurrency: null, deadline: null, roleCategory: "gtm_strategy", isInternship: true, eligibility: {}, dedupeKey: "k1" } as unknown as NormalizedJob;
    const { job } = await store.upsertJob(ctx, ing.id, norm);
    await store.setJobStage(ctx, job.id, "normalized");
    await runResearchStage(store, ctx, job.id, {
      llmEnabled: () => false,
      fetcher: async (url) => url === "https://acme.test" ? { url, status: 200, text: "Acme", description: "Acme sells widgets to retailers." } : null,
    });
    expect((await store.getJob(ctx, job.id))!.stage).toBe("researched");
    const co = (await store.getCompanyByName(ctx, "Acme"))!;
    expect(co.research).toMatchObject({ source: "stub" });
    const out = await writeProofPage(co.research as any, {}, await mkdtemp(join(tmpdir(), "p-")));
    expect(out.file).toContain("acme");

    const found = await discoverContacts(store, ctx, { name: "Acme", domain: "acme.test" }, { title: "GTM Intern", roleCategory: "gtm_strategy" },
      [ManualProvider.fromCsv("name,title,email\nJane Doe,Director of Strategy,jane@acme.test")]);
    expect(found.ranked.length).toBe(1);
    const contact = (await store.listContacts(ctx, co.id))[0]!;

    const policy = AutomationPolicy.parse({ mode: "live", autoOutreach: true });
    const t0 = new Date("2026-11-10T15:00:00Z");
    await scheduleSequence(store, ctx, { company: "Acme", jobTitle: "GTM Intern", contactName: "Jane Doe", candidateName: "Adi", candidateIntro: "an MBA student", evidence, contactId: contact.id, jobId: job.id }, policy, t0);
    let sends = 0;
    const sender: EmailSender = { name: "fake", isVerified: async () => true, send: async () => { sends++; return { messageId: "m", threadId: "th" }; } };
    const deps = (extra = {}) => ({ policy, sender, fromAddress: "me@x.test", lookupContact: async () => ({ id: contact.id, email: contact.email, suppressed: (await store.listContacts(ctx, co.id))[0]!.suppressed, name: "Jane" }), ...extra });
    await runOutreachTick(store, ctx, t0, deps());
    expect(sends).toBe(1);
    await runOutreachTick(store, ctx, new Date(t0.getTime() + 5 * 86_400_000), deps({ checkInbound: async () => [{ text: "Sounds great, call me" }] }));
    expect(sends).toBe(1);
    const rows = await store.listOutreach(ctx, { contactId: contact.id });
    expect(rows.filter((r) => r.status === "stopped").length).toBe(3);
  });
});
