import { describe, it, expect } from "vitest";
import { InMemoryStore } from "../../db/src/memory.js";
import { enqueueIngestion, processPending, runPipeline, type PipelineStages } from "../src/pipeline/index.js";
import { ctx, noSleep, stubNormalize, stubScorer } from "./helpers.js";

const JD = "Title: Product Management Intern\nCompany: Acme AI\nBuild the roadmap.";
const GH = "https://boards.greenhouse.io/acme/jobs/4242";
const base = (o: Partial<PipelineStages> = {}): PipelineStages => ({ normalize: stubNormalize, score: stubScorer(85), ...o });
const opts = { sleep: noSleep, baseDelayMs: 1 };
const live = async (s: InMemoryStore, extra: any = {}) => s.setPreferences(ctx, { policy: { mode: "live", autoApply: true, autoOutreach: false, ...extra } } as any);
const dry = async (s: InMemoryStore, extra: any = {}) => s.setPreferences(ctx, { policy: { mode: "dry_run", autoApply: true, ...extra } } as any);
const kinds = (s: InMemoryStore) => s.events.map((e) => e.kind);

describe("pipeline e2e (InMemoryStore)", () => {
  it("ingest pasted JD + Greenhouse URL -> qualified, dry-run action recorded, never 'applied'", async () => {
    const s = new InMemoryStore(); await dry(s);
    let applyCalls = 0;
    const stages = base({ apply: async (_s, _c, _j, o) => { applyCalls++; expect(o.mode).toBe("dry_run"); return { status: "dry_run", confirmed: false, confirmationEvidence: null, exception: null }; } });
    const a = await enqueueIngestion(s, ctx, { source: "manual_text", text: JD });
    const b = await enqueueIngestion(s, ctx, { source: "manual_url", url: GH });
    expect(a.ingestionId).not.toBe(b.ingestionId);
    const r = await processPending(s, stages, opts);
    expect(r.processed).toBe(2);
    expect(r.outcomes.every((o) => o.status === "done")).toBe(true);
    const jobs = [...s.jobs.values()];
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.stage === "qualified")).toBe(true);
    expect(applyCalls).toBe(2);
    expect([...s.applications.values()].every((x) => x.status === "dry_run" && x.confirmed === false)).toBe(true);
    expect(s.externalActions.filter((x) => x.status === "dry_run" && x.action === "submit_application")).toHaveLength(2);
    expect(kinds(s)).toEqual(expect.arrayContaining(["ingestion.accepted", "stage.normalize.succeeded", "stage.score.succeeded", "job.qualified", "application.dry_run"]));
    expect(jobs.some((j) => j.stage === "applied")).toBe(false);
  });

  it("same Greenhouse job ingested twice -> duplicate, exactly one application", async () => {
    const s = new InMemoryStore(); await dry(s);
    const stages = base({ apply: async () => ({ status: "dry_run", confirmed: false, confirmationEvidence: null, exception: null }) });
    await enqueueIngestion(s, ctx, { source: "manual_url", url: GH });
    await enqueueIngestion(s, ctx, { source: "mcp", url: GH });
    const r = await processPending(s, stages, opts);
    expect(r.outcomes.map((o) => o.status).sort()).toEqual(["done", "duplicate"]);
    expect(s.applications.size).toBe(1);
  });

  it("re-running a finished ingestion is a no-op", async () => {
    const s = new InMemoryStore(); await dry(s);
    const { ingestionId } = await enqueueIngestion(s, ctx, { source: "manual_text", text: JD });
    await runPipeline(s, ctx, ingestionId, base(), opts);
    const n = s.events.length;
    const again = await runPipeline(s, ctx, ingestionId, base(), opts);
    expect(again.status).toBe("skipped"); expect(s.events.length).toBe(n);
  });

  it("idempotency key returns the same ingestion", async () => {
    const s = new InMemoryStore();
    const a = await enqueueIngestion(s, ctx, { source: "mcp", text: JD, idempotencyKey: "k1" });
    const b = await enqueueIngestion(s, ctx, { source: "mcp", text: JD, idempotencyKey: "k1" });
    expect(a.ingestionId).toBe(b.ingestionId); expect(s.ingestions.size).toBe(1);
  });

  it("forced failure retries 3x with backoff then dead-letters + exception", async () => {
    const s = new InMemoryStore(); const sleeps: number[] = []; let calls = 0;
    const { ingestionId } = await enqueueIngestion(s, ctx, { source: "manual_text", text: JD });
    const out = await runPipeline(s, ctx, ingestionId, base({ normalize: async () => { calls++; throw new Error("boom"); } }), { sleep: async (ms) => { sleeps.push(ms); }, baseDelayMs: 100 });
    expect(out.status).toBe("dead_letter"); expect(calls).toBe(3); expect(sleeps).toEqual([100, 200]);
    expect(s.ingestions.get(ingestionId)!.status).toBe("dead_letter");
    expect((await s.listExceptions(ctx, true)).some((e) => e.detail.includes("dead-lettered"))).toBe(true);
    expect(kinds(s)).toContain("pipeline.dead_letter");
    // dead-lettered items are not reprocessed silently
    expect((await runPipeline(s, ctx, ingestionId, base(), opts)).status).toBe("skipped");
  });

  it("transient failure recovers within retries", async () => {
    const s = new InMemoryStore(); let n = 0;
    const { ingestionId } = await enqueueIngestion(s, ctx, { source: "manual_text", text: JD });
    const out = await runPipeline(s, ctx, ingestionId, base({ normalize: async (r) => { if (++n < 3) throw new Error("flaky"); return stubNormalize(r); } }), opts);
    expect(out.status).toBe("done");
  });

  it("low score -> archived, no application", async () => {
    const s = new InMemoryStore(); await dry(s);
    const { ingestionId } = await enqueueIngestion(s, ctx, { source: "manual_text", text: JD });
    const out = await runPipeline(s, ctx, ingestionId, base({ score: stubScorer(30, "archive") }), opts);
    expect(out).toMatchObject({ status: "done", stage: "archived" }); expect(s.applications.size).toBe(0);
  });

  it("scorer says qualify but total below policy threshold -> archived (policy wins)", async () => {
    const s = new InMemoryStore(); await dry(s, { minScoreToApply: 90 });
    const { ingestionId } = await enqueueIngestion(s, ctx, { source: "manual_text", text: JD });
    expect((await runPipeline(s, ctx, ingestionId, base(), opts))).toMatchObject({ stage: "archived" });
  });

  it("autoApply=false (default) never calls the adapter", async () => {
    const s = new InMemoryStore(); let called = false;
    const { ingestionId } = await enqueueIngestion(s, ctx, { source: "manual_text", text: JD });
    await runPipeline(s, ctx, ingestionId, base({ apply: async () => { called = true; throw new Error("no"); } }), opts);
    expect(called).toBe(false); expect(kinds(s)).toContain("application.skipped_policy");
  });

  it("live: confirmed submission with evidence -> applied; unconfirmed -> needs_human, NOT applied", async () => {
    const s = new InMemoryStore(); await live(s);
    const ok = await enqueueIngestion(s, ctx, { source: "manual_url", url: GH });
    await runPipeline(s, ctx, ok.ingestionId, base({ apply: async () => ({ status: "succeeded", confirmed: true, confirmationEvidence: { kind: "confirmation_page_text", detail: "Thanks for applying" }, exception: null }) }), opts);
    expect([...s.jobs.values()][0]!.stage).toBe("applied");
    expect(s.externalActions.some((x) => x.status === "succeeded")).toBe(true);

    const s2 = new InMemoryStore(); await live(s2);
    const bad = await enqueueIngestion(s2, ctx, { source: "manual_text", text: JD });
    await runPipeline(s2, ctx, bad.ingestionId, base({ apply: async () => ({ status: "succeeded", confirmed: false, confirmationEvidence: null, exception: null }) }), opts);
    expect([...s2.jobs.values()][0]!.stage).toBe("needs_human");
    expect(s2.externalActions.some((x) => x.status === "unverified")).toBe(true);
    expect((await s2.listExceptions(ctx, true)).some((e) => e.type === "submission_unverified")).toBe(true);
  });

  it("live: 'succeeded' claim without evidence is not trusted", async () => {
    const s = new InMemoryStore(); await live(s);
    const i = await enqueueIngestion(s, ctx, { source: "manual_text", text: JD });
    await runPipeline(s, ctx, i.ingestionId, base({ apply: async () => ({ status: "succeeded", confirmed: true, confirmationEvidence: null, exception: null }) }), opts);
    expect([...s.jobs.values()][0]!.stage).not.toBe("applied");
  });

  it("captcha exception -> exception queue with right type", async () => {
    const s = new InMemoryStore(); await live(s);
    const i = await enqueueIngestion(s, ctx, { source: "manual_text", text: JD });
    await runPipeline(s, ctx, i.ingestionId, base({ apply: async () => ({ status: "failed", confirmed: false, confirmationEvidence: null, exception: { type: "captcha", detail: "CAPTCHA on submit" } }) }), opts);
    expect((await s.listExceptions(ctx, true)).map((e) => e.type)).toContain("captcha");
  });

  it("daily application cap is enforced", async () => {
    const s = new InMemoryStore(); await dry(s, { maxApplicationsPerDay: 1 }); let calls = 0;
    const stages = base({ apply: async () => { calls++; return { status: "dry_run", confirmed: false, confirmationEvidence: null, exception: null }; } });
    await enqueueIngestion(s, ctx, { source: "manual_text", text: "Title: A\nCompany: X" });
    await enqueueIngestion(s, ctx, { source: "manual_text", text: "Title: B\nCompany: Y" });
    await processPending(s, stages, opts);
    expect(calls).toBe(1); expect(kinds(s)).toContain("application.skipped_cap");
  });

  it("missing optional stages are logged as skipped, not faked", async () => {
    const s = new InMemoryStore(); await dry(s);
    const i = await enqueueIngestion(s, ctx, { source: "manual_text", text: JD });
    await runPipeline(s, ctx, i.ingestionId, base(), opts);
    expect(kinds(s)).toContain("stage.research.skipped"); expect(kinds(s)).toContain("stage.resume.skipped");
  });

  it("proof-of-work/contacts run only for high-score jobs; outreach only with autoOutreach", async () => {
    const s = new InMemoryStore(); await dry(s, { autoOutreach: true });
    const calls: string[] = [];
    const mk = (n: string) => async () => { calls.push(n); };
    const i = await enqueueIngestion(s, ctx, { source: "manual_text", text: JD });
    await runPipeline(s, ctx, i.ingestionId, base({ contacts: mk("contacts"), proofOfWork: mk("pow"), outreach: mk("outreach"), followups: mk("fu") }), opts);
    expect(calls).toEqual(["contacts", "pow", "outreach", "fu"]);
    const s2 = new InMemoryStore(); await dry(s2, { autoOutreach: false }); calls.length = 0;
    const j = await enqueueIngestion(s2, ctx, { source: "manual_text", text: JD });
    await runPipeline(s2, ctx, j.ingestionId, base({ contacts: mk("contacts"), outreach: mk("outreach") }), opts);
    expect(calls).toEqual(["contacts"]);
  });
});

describe("blocking exceptions", () => {
  it("open exception raised by resume stage blocks applying", async () => {
    const s = new InMemoryStore(); await dry(s); let applied = false;
    const i = await enqueueIngestion(s, ctx, { source: "manual_text", text: JD });
    await runPipeline(s, ctx, i.ingestionId, base({
      resume: async (st, c, jobId) => { await st.raiseException(c, { ctx: c, type: "missing_profile_field", entityType: "job", entityId: jobId, detail: "Evidence bank is empty" }); },
      apply: async () => { applied = true; return { status: "dry_run", confirmed: false, confirmationEvidence: null, exception: null }; },
    }), opts);
    expect(applied).toBe(false); expect([...s.jobs.values()][0]!.stage).toBe("needs_human"); expect(kinds(s)).toContain("application.skipped_blocked");
  });
});
