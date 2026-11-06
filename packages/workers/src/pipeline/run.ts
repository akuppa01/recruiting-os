import type { Ctx, JobRow, JobStage, Preferences, Store } from "@ros/core";
import { DryRunNotifier, notify } from "../notify/index.js";
import { realSleep, withRetry } from "./retry.js";
import type { PipelineOpts, PipelineOutcome, PipelineStages, StageFn } from "./types.js";

const startOfDay = (d: Date) => { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); return x.toISOString(); };
// Order used to resume a partially-processed job without redoing earlier stages.
const RANK: Partial<Record<JobStage, number>> = { ingested: 0, normalized: 1, researched: 2, scored: 3, qualified: 4, applying: 5 };
const rank = (s: JobStage) => RANK[s] ?? 99;

class StageFailure extends Error { constructor(public stage: string, msg: string, public jobId: string | null) { super(msg); } }

export async function runPipeline(store: Store, ctx: Ctx, ingestionId: string, stages: PipelineStages, opts: PipelineOpts = {}): Promise<PipelineOutcome> {
  const notifier = opts.notifier ?? new DryRunNotifier();
  const retryO = { attempts: opts.maxAttempts ?? 3, baseDelayMs: opts.baseDelayMs ?? 500, sleep: opts.sleep ?? realSleep };
  const now = opts.now ?? (() => new Date());

  const ing = await store.getIngestion(ctx, ingestionId);
  if (!ing) return { status: "skipped", reason: "ingestion not found" };
  if (ing.status === "done" || ing.status === "dead_letter") return { status: "skipped", reason: `already ${ing.status}` };
  let jobId: string | null = ing.jobId;

  // Run one stage with retries, per-stage events; throws StageFailure after attempts exhausted.
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    await store.logEvent(ctx, `stage.${name}.started`, "ingestion", ingestionId, { jobId });
    try {
      const out = await withRetry(async (attempt) => {
        try { return await fn(); } catch (e) {
          await store.logEvent(ctx, `stage.${name}.attempt_failed`, "ingestion", ingestionId, { attempt, error: (e as Error).message });
          await store.updateIngestion(ctx, ingestionId, { attempts: (ing.attempts ?? 0) + attempt });
          throw e;
        }
      }, retryO);
      await store.logEvent(ctx, `stage.${name}.succeeded`, "ingestion", ingestionId, { jobId });
      return out;
    } catch (e) { throw new StageFailure(name, (e as Error).message, jobId); }
  };
  const optional = async (name: string, fn: StageFn | undefined, id: string) => {
    if (!fn) { await store.logEvent(ctx, `stage.${name}.skipped`, "job", id, { reason: "stage not configured" }); return; }
    await step(name, () => fn(store, ctx, id));
  };

  try {
    const prefs: Preferences = await store.getPreferences(ctx);
    const policy = prefs.policy;
    let job: JobRow | null = jobId ? await store.getJob(ctx, jobId) : null;

    // 1-2. Normalize + dedupe
    if (!job) {
      const normalized = await step("normalize", () => stages.normalize(ing.request));
      const up = await step("dedupe", () => store.upsertJob(ctx, ingestionId, normalized));
      jobId = up.job.id; job = up.job;
      await store.updateIngestion(ctx, ingestionId, { jobId });
      if (up.duplicate) {
        await store.setJobStage(ctx, jobId, "duplicate");
        await store.logEvent(ctx, "job.duplicate", "job", jobId, { duplicateOf: up.job.duplicateOf });
        await store.updateIngestion(ctx, ingestionId, { status: "done" });
        return { status: "duplicate", jobId, duplicateOf: up.job.duplicateOf ?? jobId };
      }
      await store.setJobStage(ctx, jobId, "normalized");
      await store.logEvent(ctx, "job.ingested", "job", jobId, { company: job.normalized.company, title: job.normalized.title });
    }
    const id = jobId!;
    const cur = async () => (await store.getJob(ctx, id))!;

    // 3. Research
    if (rank((await cur()).stage) <= 1) { await optional("research", stages.research, id); if ((await cur()).stage === "normalized") await store.setJobStage(ctx, id, "researched"); }

    // 4. Score
    if (rank((await cur()).stage) <= 2) await step("score", () => stages.score(store, ctx, id));
    job = await cur();
    if (job.stage === "archived") { // scorer archived it itself
      await store.logEvent(ctx, "job.archived", "job", id, { total: job.score?.total ?? null, hardRejects: job.score?.hardRejects ?? [] });
      await store.updateIngestion(ctx, ingestionId, { status: "done" });
      return { status: "done", jobId: id, stage: "archived" };
    }
    if (job.stage === "scored" || job.stage === "qualified") {
      // 5. Archive or qualify. Policy threshold is enforced here regardless of what the scorer decided.
      const sc = job.score;
      if (!sc) throw new StageFailure("score", "scorer did not persist a score", id);
      if (sc.hardRejects.length > 0 || sc.decision === "archive" || sc.total < policy.minScoreToApply) {
        await store.setJobStage(ctx, id, "archived", sc);
        await store.logEvent(ctx, "job.archived", "job", id, { total: sc.total, hardRejects: sc.hardRejects });
        await store.updateIngestion(ctx, ingestionId, { status: "done" });
        return { status: "done", jobId: id, stage: "archived" };
      }
      if (sc.decision === "needs_review") {
        const open = (await store.listExceptions(ctx, true)).some((x) => x.entityType === "job" && x.entityId === id);
        if (!open) await store.raiseException(ctx, { ctx, type: "low_factual_confidence", entityType: "job", entityId: id, detail: `Scorer flagged needs_review: ${sc.rationale}` });
        await store.setJobStage(ctx, id, "needs_human", sc);
        await notify(store, ctx, notifier, { kind: "exception", title: "Job needs review", body: `${job.normalized.company} — ${job.normalized.title}` }, { quiet: policy.quietHours, now: now() });
        await store.updateIngestion(ctx, ingestionId, { status: "done" });
        return { status: "done", jobId: id, stage: "needs_human" };
      }
      if (job.stage !== "qualified") await store.setJobStage(ctx, id, "qualified", sc);
      await store.logEvent(ctx, "job.qualified", "job", id, { total: sc.total });
      if (sc.total >= policy.minScoreForProofOfWork) await notify(store, ctx, notifier, { kind: "high_score_job", title: `High-fit job (${sc.total})`, body: `${job.normalized.company} — ${job.normalized.title}` }, { quiet: policy.quietHours, now: now() });
    }

    // 6-7. Resume + cover letter (needed for application; skipped stage logs are explicit)
    job = await cur();
    if (job.stage === "qualified" || job.stage === "applying") {
      await optional("resume", stages.resume, id);
      await optional("coverLetter", stages.coverLetter, id);

      // A stage that raised an open exception on this job (e.g. empty evidence bank, low factual confidence) blocks applying.
      const blocking = (await store.listExceptions(ctx, true)).filter((x) => x.entityType === "job" && x.entityId === id);
      if (blocking.length > 0) {
        await store.logEvent(ctx, "application.skipped_blocked", "job", id, { exceptions: blocking.map((b) => b.type) });
        await store.setJobStage(ctx, id, "needs_human");
        await notify(store, ctx, notifier, { kind: "exception", title: "Job blocked before applying", body: `${job.normalized.company}: ${blocking[0]!.detail}` });
      } else

      // 8-10. Apply under policy gating; orchestrator enforces confirmation rule + idempotency
      await applyUnderPolicy(store, ctx, id, stages, prefs, step, notifier, now);
    }

    // 11-12. CRM is the DB itself; research people + proof-of-work for high-priority roles
    const fin = await cur();
    const sc = fin.score;
    if (sc && sc.total >= policy.minScoreForProofOfWork && fin.stage !== "archived") {
      await optional("contacts", stages.contacts, id);
      await optional("proofOfWork", stages.proofOfWork, id);
    }
    // 13-14. Outreach + follow-ups only when autoOutreach is on; otherwise logged as policy-skipped
    if (sc && sc.total >= policy.minScoreToApply && fin.stage !== "archived") {
      if (!policy.autoOutreach) await store.logEvent(ctx, "outreach.skipped_policy", "job", id, { reason: "autoOutreach disabled" });
      else if (await dailyCount(store, ctx, "outreach.attempted", now()) >= policy.maxOutreachPerDay) await store.logEvent(ctx, "outreach.skipped_cap", "job", id, { cap: policy.maxOutreachPerDay });
      else { await store.logEvent(ctx, "outreach.attempted", "job", id); await optional("outreach", stages.outreach, id); await optional("followups", stages.followups, id); }
    }

    await store.updateIngestion(ctx, ingestionId, { status: "done" });
    return { status: "done", jobId: id, stage: (await cur()).stage };
  } catch (e) {
    const f = e instanceof StageFailure ? e : new StageFailure("unknown", (e as Error).message, jobId);
    await store.updateIngestion(ctx, ingestionId, { status: "dead_letter", error: `${f.stage}: ${f.message}` });
    await store.raiseException(ctx, { ctx, type: "other", entityType: "ingestion", entityId: ingestionId, detail: `Pipeline dead-lettered at stage "${f.stage}" after retries: ${f.message}` });
    await store.logEvent(ctx, "pipeline.dead_letter", "ingestion", ingestionId, { stage: f.stage, error: f.message, jobId: f.jobId });
    await notify(store, ctx, notifier, { kind: "dead_letter", title: "Pipeline failure (dead-lettered)", body: `Stage ${f.stage}: ${f.message}` });
    return { status: "dead_letter", jobId: f.jobId, failedStage: f.stage, error: f.message };
  }
}

async function dailyCount(store: Store, ctx: Ctx, kind: string, now: Date): Promise<number> {
  const since = startOfDay(now);
  return (await store.listEvents(ctx, { kind, limit: 5000 })).filter((e) => e.createdAt >= since).length;
}

async function applyUnderPolicy(store: Store, ctx: Ctx, jobId: string, stages: PipelineStages, prefs: Preferences, step: <T>(n: string, f: () => Promise<T>) => Promise<T>, notifier: NonNullable<PipelineOpts["notifier"]>, now: () => Date) {
  const policy = prefs.policy;
  if (!policy.autoApply) { await store.logEvent(ctx, "application.skipped_policy", "job", jobId, { reason: "autoApply disabled" }); return; }
  if (!stages.apply) { await store.logEvent(ctx, "stage.apply.skipped", "job", jobId, { reason: "adapter not configured" }); return; }
  if (await dailyCount(store, ctx, "application.attempted", now()) >= policy.maxApplicationsPerDay) { await store.logEvent(ctx, "application.skipped_cap", "job", jobId, { cap: policy.maxApplicationsPerDay }); return; }

  const { app, created } = await store.getOrCreateApplication(ctx, jobId);
  if (!created && (app.confirmed || app.status === "succeeded")) { await store.logEvent(ctx, "application.skipped_duplicate", "job", jobId, { applicationId: app.id }); return; }
  const job = (await store.getJob(ctx, jobId))!;
  await store.logEvent(ctx, "application.attempted", "job", jobId, { applicationId: app.id, mode: policy.mode });
  await store.setJobStage(ctx, jobId, "applying");
  const res = await step("apply", () => stages.apply!(store, ctx, job, { mode: policy.mode, applicationId: app.id, resumeVersionId: app.resumeVersionId }));
  const system = job.normalized.atsKind;

  if (policy.mode === "dry_run" || res.status === "dry_run") {
    // Dry-run NEVER marks applied.
    await store.updateApplication(ctx, app.id, { status: "dry_run", confirmed: false, attempts: app.attempts + 1 });
    await store.recordExternalAction(ctx, { system, action: "submit_application", status: "dry_run", entityId: app.id, detail: "dry-run: nothing submitted" });
    await store.setJobStage(ctx, jobId, "qualified");
    await store.logEvent(ctx, "application.dry_run", "job", jobId, { applicationId: app.id });
    return;
  }
  if (res.status === "succeeded" && res.confirmed && res.confirmationEvidence) {
    await store.updateApplication(ctx, app.id, { status: "succeeded", confirmed: true, evidence: res.confirmationEvidence, submittedAt: now().toISOString(), attempts: app.attempts + 1 });
    await store.recordExternalAction(ctx, { system, action: "submit_application", status: "succeeded", entityId: app.id, detail: res.confirmationEvidence.detail });
    await store.setJobStage(ctx, jobId, "applied");
    await store.logEvent(ctx, "application.confirmed", "job", jobId, { applicationId: app.id });
    await notify(store, ctx, notifier, { kind: "application_confirmed", title: "Application submitted", body: `${job.normalized.company} — ${job.normalized.title}` }, { quiet: policy.quietHours, now: now() });
    return;
  }
  // Anything else: no confirmation evidence => never "applied".
  const failed = res.status === "failed";
  await store.updateApplication(ctx, app.id, { status: failed ? "failed" : "unverified", confirmed: false, lastError: res.exception?.detail ?? null, attempts: app.attempts + 1 });
  await store.recordExternalAction(ctx, { system, action: "submit_application", status: failed ? "failed" : "unverified", entityId: app.id, detail: res.exception?.detail });
  await store.raiseException(ctx, { ctx, type: res.exception?.type ?? "submission_unverified", entityType: "application", entityId: app.id, detail: res.exception?.detail ?? "Submission could not be confirmed; verify manually before retrying" });
  await store.setJobStage(ctx, jobId, "needs_human");
  await notify(store, ctx, notifier, { kind: "exception", title: "Application needs attention", body: `${job.normalized.company} — ${res.exception?.detail ?? "unverified submission"}` });
}
