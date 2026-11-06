import { describe, it, expect } from "vitest";
import { NormalizedJob, type Store, type Ctx } from "@ros/core";
import { randomUUID } from "node:crypto";

export const mkJob = (over: Partial<NormalizedJob> = {}): NormalizedJob =>
  NormalizedJob.parse({ title: "PM Intern", company: "Acme", dedupeKey: "k-" + randomUUID(), description: "build things", ...over });

/** Shared suite: any Store implementation must pass. makeStore must return a fresh store; ctxs fresh tenants. */
export function storeConformance(name: string, makeStore: () => Promise<Store> | Store, opts: { skip?: boolean } = {}) {
  const d = opts.skip ? describe.skip : describe;
  d(`Store conformance: ${name}`, () => {
    const mk = async () => {
      const store = await makeStore();
      const A: Ctx = { tenantId: randomUUID(), userId: randomUUID() };
      const B: Ctx = { tenantId: randomUUID(), userId: randomUUID() };
      return { store, A, B };
    };

    it("ingestion is idempotent on idempotencyKey", async () => {
      const { store, A } = await mk();
      const r1 = await store.createIngestion(A, { source: "manual_url", url: "https://x.com/j", idempotencyKey: "abc" });
      const r2 = await store.createIngestion(A, { source: "manual_url", url: "https://x.com/j", idempotencyKey: "abc" });
      expect(r2.id).toBe(r1.id);
      const r3 = await store.createIngestion(A, { source: "manual_url", url: "https://x.com/j2" });
      expect(r3.id).not.toBe(r1.id);
      expect(r1.status).toBe("accepted");
    });

    it("same idempotencyKey in another tenant is a different ingestion", async () => {
      const { store, A, B } = await mk();
      const a = await store.createIngestion(A, { source: "mcp", text: "t", idempotencyKey: "k" });
      const b = await store.createIngestion(B, { source: "mcp", text: "t", idempotencyKey: "k" });
      expect(a.id).not.toBe(b.id);
    });

    it("dedupe by dedupeKey marks second job duplicate", async () => {
      const { store, A } = await mk();
      const i1 = await store.createIngestion(A, { source: "manual_text", text: "1" });
      const i2 = await store.createIngestion(A, { source: "manual_text", text: "2" });
      const n = mkJob({ dedupeKey: "same" });
      const r1 = await store.upsertJob(A, i1.id, n);
      const r2 = await store.upsertJob(A, i2.id, n);
      expect(r1.duplicate).toBe(false);
      expect(r2.duplicate).toBe(true);
      expect(r2.job.stage).toBe("duplicate");
      expect(r2.job.duplicateOf).toBe(r1.job.id);
      // re-upserting same ingestion is stable
      const r2b = await store.upsertJob(A, i2.id, n);
      expect(r2b.job.id).toBe(r2.job.id);
    });

    it("dedupe is scoped per tenant", async () => {
      const { store, A, B } = await mk();
      const ia = await store.createIngestion(A, { source: "manual_text", text: "1" });
      const ib = await store.createIngestion(B, { source: "manual_text", text: "1" });
      const n = mkJob({ dedupeKey: "shared" });
      await store.upsertJob(A, ia.id, n);
      const rb = await store.upsertJob(B, ib.id, n);
      expect(rb.duplicate).toBe(false);
    });

    it("stage updates, scoring, search and pipeline counts", async () => {
      const { store, A } = await mk();
      const i = await store.createIngestion(A, { source: "manual_text", text: "1" });
      const { job } = await store.upsertJob(A, i.id, mkJob({ title: "Growth Intern" }));
      await store.setJobStage(A, job.id, "qualified", {
        total: 82, roleFit: 1, comp: 1, conversion: 1, responsibility: 1, flexibility: 1, upside: 1, entrepreneurialCompat: 1,
        hardRejects: [], rationale: "r", decision: "qualify",
      });
      expect((await store.getJob(A, job.id))?.stage).toBe("qualified");
      expect((await store.searchJobs(A, { minScore: 80 })).length).toBe(1);
      expect((await store.searchJobs(A, { text: "growth" })).length).toBe(1);
      expect((await store.searchJobs(A, { text: "nomatch" })).length).toBe(0);
      const c = await store.pipelineCounts(A);
      expect(c.qualified).toBe(1);
      expect(c.applied).toBe(0);
    });

    it("getOrCreateApplication is idempotent: one application per tenant+job", async () => {
      const { store, A } = await mk();
      const i = await store.createIngestion(A, { source: "manual_text", text: "1" });
      const { job } = await store.upsertJob(A, i.id, mkJob());
      const [x, y] = await Promise.all([store.getOrCreateApplication(A, job.id), store.getOrCreateApplication(A, job.id)]);
      expect(x.app.id).toBe(y.app.id);
      expect([x.created, y.created].filter(Boolean).length).toBe(1);
      expect(x.app.confirmed).toBe(false);
      expect(x.app.status).toBe("pending");
    });

    it("application cannot be marked confirmed without evidence", async () => {
      const { store, A } = await mk();
      const i = await store.createIngestion(A, { source: "manual_text", text: "1" });
      const { job } = await store.upsertJob(A, i.id, mkJob());
      const { app } = await store.getOrCreateApplication(A, job.id);
      await expect(store.updateApplication(A, app.id, { confirmed: true, status: "succeeded" })).rejects.toThrow();
      await store.updateApplication(A, app.id, { confirmed: true, status: "succeeded", evidence: { kind: "api_response", detail: "200" } });
      expect((await store.getApplicationByJob(A, job.id))?.confirmed).toBe(true);
    });

    it("suppressContact stops pending outreach but not sent", async () => {
      const { store, A } = await mk();
      const co = await store.upsertCompany(A, "Acme", "acme.com");
      const ct = await store.upsertContact(A, { ctx: A, companyId: co.id, name: "Pat", title: "VP", email: "p@acme.com", linkedinUrl: null, relevance: 0.9, source: "t" });
      const base = { ctx: A, contactId: ct.id, jobId: null, channel: "email" as const, subject: "s", body: "b", scheduledFor: new Date(Date.now() + 1e6).toISOString() };
      const o1 = await store.createOutreach(A, { ...base, step: 1, status: "sent" });
      const o2 = await store.createOutreach(A, { ...base, step: 2, status: "scheduled" });
      const o3 = await store.createOutreach(A, { ...base, step: 3, status: "draft" });
      await store.suppressContact(A, ct.id, "replied");
      const all = await store.listOutreach(A, { contactId: ct.id });
      const byId = Object.fromEntries(all.map((o) => [o.id, o]));
      expect(byId[o1.id]!.status).toBe("sent");
      expect(byId[o2.id]!.status).toBe("stopped");
      expect(byId[o3.id]!.status).toBe("stopped");
      expect(byId[o2.id]!.stopReason).toBe("replied");
      expect((await store.listContacts(A, co.id))[0]!.suppressed).toBe(true);
    });

    it("tenant isolation: ctx B cannot read or mutate ctx A data", async () => {
      const { store, A, B } = await mk();
      const i = await store.createIngestion(A, { source: "manual_text", text: "secret" });
      const { job } = await store.upsertJob(A, i.id, mkJob({ title: "Secret Role" }));
      const co = await store.upsertCompany(A, "SecretCo", null);
      await store.raiseException(A, { ctx: A, type: "captcha", entityType: "job", entityId: job.id, detail: "d" });
      await store.logEvent(A, "job.ingested", "job", job.id);
      expect(await store.getIngestion(B, i.id)).toBeNull();
      expect(await store.getJob(B, job.id)).toBeNull();
      expect(await store.searchJobs(B, {})).toHaveLength(0);
      expect(await store.listExceptions(B)).toHaveLength(0);
      expect(await store.listEvents(B, {})).toHaveLength(0);
      expect(await store.getCompanyByName(B, "SecretCo")).toBeNull();
      await store.setJobStage(B, job.id, "rejected");
      expect((await store.getJob(A, job.id))?.stage).toBe("normalized");
      await store.updateIngestion(B, i.id, { status: "failed" });
      expect((await store.getIngestion(A, i.id))?.status).not.toBe("failed");
      expect((await store.pipelineCounts(B)).normalized).toBe(0);
      expect(co.id).toBeTruthy();
    });

    it("event log records and filters", async () => {
      const { store, A } = await mk();
      await store.logEvent(A, "job.ingested", "job", "e1", { a: 1 });
      await store.logEvent(A, "job.scored", "job", "e1");
      await store.logEvent(A, "job.scored", "job", "e2");
      expect((await store.listEvents(A, {})).length).toBe(3);
      expect((await store.listEvents(A, { entityId: "e1" })).length).toBe(2);
      expect((await store.listEvents(A, { kind: "job.scored" })).length).toBe(2);
    });

    it("preferences default to dry_run and persist patches", async () => {
      const { store, A } = await mk();
      const p = await store.getPreferences(A);
      expect(p.policy.mode).toBe("dry_run");
      expect(p.policy.autoApply).toBe(false);
      const n = await store.setPreferences(A, { excludedCompanies: ["Evil"] });
      expect(n.excludedCompanies).toEqual(["Evil"]);
      expect((await store.getPreferences(A)).excludedCompanies).toEqual(["Evil"]);
    });

    it("claimIngestions moves accepted -> processing once", async () => {
      const { store, A } = await mk();
      const i = await store.createIngestion(A, { source: "manual_text", text: "1" });
      const c1 = await store.claimIngestions(1000);
      expect(c1.some((x) => x.id === i.id)).toBe(true);
      const c2 = await store.claimIngestions(1000);
      expect(c2.some((x) => x.id === i.id)).toBe(false);
    });
  });
}
