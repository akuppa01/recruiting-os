import type { Ctx, Store } from "@ros/core";
import { normalizeJob, rawFromRequest } from "../normalize/index.js";
import { scoreJob } from "../score/index.js";

/** ingestionId -> NormalizedJob row. Handles dedupe via Store.upsertJob. Never throws for bad content; marks ingestion failed. */
export async function runNormalizeStage(store: Store, ctx: Ctx, ingestionId: string): Promise<void> {
  const ing = await store.getIngestion(ctx, ingestionId);
  if (!ing) throw new Error(`ingestion ${ingestionId} not found`);
  try {
    const normalized = normalizeJob(rawFromRequest(ing.request));
    const { job, duplicate } = await store.upsertJob(ctx, ingestionId, normalized);
    await store.updateIngestion(ctx, ingestionId, { status: "done", jobId: job.id, error: null });
    await store.logEvent(ctx, duplicate ? "job.duplicate" : "job.normalized", "job", job.id, {
      ingestionId, dedupeKey: normalized.dedupeKey, atsKind: normalized.atsKind, roleCategory: normalized.roleCategory,
    });
    if (!duplicate && job.stage === "ingested") await store.setJobStage(ctx, job.id, "normalized");
  } catch (e) {
    await store.updateIngestion(ctx, ingestionId, { status: "failed", error: (e as Error).message, attempts: ing.attempts + 1 });
    await store.logEvent(ctx, "ingestion.failed", "ingestion", ingestionId, { error: (e as Error).message });
    throw e;
  }
}

/** jobId -> score + stage (qualified | archived | needs_human via exception queue for borderline). */
export async function runScoreStage(store: Store, ctx: Ctx, jobId: string): Promise<void> {
  const job = await store.getJob(ctx, jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  if (job.stage === "duplicate") return;
  const prefs = await store.getPreferences(ctx);
  const score = scoreJob(job.normalized, prefs);
  if (score.decision === "qualify") {
    await store.setJobStage(ctx, jobId, "qualified", score);
  } else if (score.decision === "archive") {
    await store.setJobStage(ctx, jobId, "archived", score);
  } else {
    await store.setJobStage(ctx, jobId, "scored", score);
    await store.raiseException(ctx, { ctx, type: "other", entityType: "job", entityId: jobId, detail: `Borderline score ${score.total}: ${score.rationale}` });
  }
  await store.logEvent(ctx, "job.scored", "job", jobId, { total: score.total, decision: score.decision, hardRejects: score.hardRejects });
}
