import { describe, it, expect } from "vitest";
import { InMemoryStore } from "@ros/db";
import { runNormalizeStage, runScoreStage } from "../src/stages/index.js";
import { runResumeStage } from "../src/resume/index.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ctx = { tenantId: "t1", userId: "u1" };

describe("Agent B stages against the real InMemoryStore (Agent A)", () => {
  it("ingest -> normalize -> score -> resume-blocked (no evidence), dedupe on re-ingest", async () => {
    const s = new InMemoryStore();
    const req = { source: "manual_text" as const, text: "Product Marketing Intern at Acme\nLocation: Austin, TX\nSummer 2027 MBA internship. Return offer. Own positioning and launches. $52/hr" };
    const a = await s.createIngestion(ctx, req);
    await runNormalizeStage(s, ctx, a.id);
    const jobId = (await s.getIngestion(ctx, a.id))!.jobId!;
    await runScoreStage(s, ctx, jobId);
    const job = (await s.getJob(ctx, jobId))!;
    expect(job.normalized.roleCategory).toBe("product_marketing");
    expect(job.stage).toBe("qualified");
    expect(job.score!.decision).toBe("qualify");

    const empty = mkdtempSync(join(tmpdir(), "ev-"));
    expect(await runResumeStage(s, ctx, jobId, { evidenceDir: empty })).toBeNull();
    expect([...s.exceptions.values()].some((e) => e.type === "missing_profile_field")).toBe(true);

    const b = await s.createIngestion(ctx, { ...req, idempotencyKey: undefined });
    await runNormalizeStage(s, ctx, b.id);
    const dup = (await s.getJob(ctx, (await s.getIngestion(ctx, b.id))!.jobId!))!;
    expect(dup.stage).toBe("duplicate"); expect(dup.duplicateOf).toBe(jobId);
    await runScoreStage(s, ctx, dup.id);
    expect(dup.score).toBeNull(); // duplicates are never scored/applied
  });
});
