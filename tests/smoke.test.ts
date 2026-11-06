// Cross-package smoke: REAL normalize/score/research/resume stages (Agents B, C) driven by the orchestrator (E) on InMemoryStore (A).
import { describe, it, expect } from "vitest";
import { InMemoryStore } from "@ros/db/src/memory.js";
import { createDefaultStages, enqueueIngestion, processPending } from "@ros/workers";
import { PipelineOutcome } from "@ros/workers/src/pipeline/types.js";

const ctx = { tenantId: "t", userId: "u" };
const JD = `Product Management Intern at Acme AI

Location: New York, NY
Paid internship, $50/hour. MBA candidates. Own the roadmap for our AI product, partner with engineering, run customer discovery.
Apply: https://boards.greenhouse.io/acme/jobs/777`;

describe("real stages end-to-end (no network, no LLM key)", () => {
  it("pasted JD flows through normalize→score→(research/resume)→dry-run, nothing marked applied", async () => {
    const s = new InMemoryStore();
    await s.setPreferences(ctx, { policy: { mode: "dry_run", autoApply: true } } as any);
    const noNet = { fetcher: async () => ({ ok: false, status: 0, text: "" }) } as any;
    const stages = createDefaultStages({ research: noNet, resume: { evidenceDir: "/nonexistent" } });
    const a = await enqueueIngestion(s, ctx, { source: "manual_text", text: JD });
    const r = await processPending(s, stages, { sleep: async () => {}, baseDelayMs: 1 });
    expect(r.processed).toBe(1);
    const o = r.outcomes[0] as PipelineOutcome;
    expect(["done"]).toContain(o.status);
    const job = [...s.jobs.values()][0]!;
    expect(job.normalized.company.toLowerCase()).toContain("acme");
    expect(job.score).not.toBeNull();
    expect(job.stage).not.toBe("applied");
    const kinds = s.events.map((e) => e.kind);
    expect(kinds).toContain("stage.score.succeeded");
    expect(s.ingestions.get(a.ingestionId)!.status).toBe("done");
    // empty evidence bank must block applying (no invented resume) and surface an exception
    if (job.stage === "needs_human") expect((await s.listExceptions(ctx, true)).length).toBeGreaterThan(0);
    expect(s.applications.size === 0 || [...s.applications.values()].every((x) => !x.confirmed)).toBe(true);
  });
});
