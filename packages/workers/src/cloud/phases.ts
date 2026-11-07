// The unattended pipeline phases. Every dependency is injected so the phases run against in-memory stores and mock forms in tests
// and against Supabase in the cloud worker. Logging is limited to ids, company, title, ATS, outcome codes and counts (public repo).
import { readFileSync } from "node:fs";
import {
  DEFAULT_LIMITS, type AtsKind, type Ctx, type DiscoveredJob, type PipelineLimits, type Preferences, type SourceAdapter,
  type SourceHealthStore, type Store, type Task, type TaskHandler, type TaskQueue,
} from "@ros/core";
import { applyToJob, draftEssayAnswer, type ApplyDeps, type ApplyReport, type LlmFn } from "../apply/index.js";
import type { FormTemplateStore } from "@ros/core";
import type { CandidateProfile } from "../resume/evidence.js";
import { createEmailAdapter } from "../discovery/email.js";
import { runDiscovery } from "../discovery/run.js";
import { pool } from "../discovery/util.js";
import type { EmailLike } from "../gmail/alerts.js";
import type { GmailResult } from "../gmail/connector.js";
import type { Notification } from "../notify/index.js";
import { setLlmUsageSink } from "../llm.js";
import { deadlinePriority } from "../qualify/qualify.js";
import { NonRetryableError, runWorker, type WorkerEvent } from "../queue/index.js";
import type { SpendReader } from "../queue/types.js";
import type { AssetBundle } from "./assets.js";
import type { DraftCache } from "./drafts.js";
import { ingestDiscovered, type IngestOptions } from "./ingest.js";
import { docxText, highlightedText, pickResumeBase } from "./profile.js";
import { UsageMeter, type UsageRecorder } from "./usage.js";

const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const SUPPORTED_ATS = new Set<AtsKind>(["greenhouse", "lever", "ashby"]);

// ====================================================================== phase A: discovery + ingestion
export interface PushedEmail { taskId: string; email: EmailLike & { threadId?: string } }

export interface DiscoveryPhaseDeps {
  store: Store; ctx: Ctx; prefs: Preferences; log: (m: string) => void;
  feedAdapters: SourceAdapter[];
  healthStore: SourceHealthStore;
  /** Alert emails pushed by n8n (tasks written by /api/internal/gmail-sync). Empty => email sources are not touched (their health is left as it was). */
  pushedEmails?: PushedEmail[];
  now?: () => Date; enrich?: IngestOptions["enrich"]; concurrency?: number;
}
export interface DiscoveryPhaseResult {
  found: number; created: number; existing: number; duplicates: number; unresolved: number;
  qualified: number; review: number; archived: number; failed: number;
  sourceErrors: string[]; emailsProcessed: number;
}

export async function discoveryPhase(d: DiscoveryPhaseDeps): Promise<DiscoveryPhaseResult> {
  const adapters = [...d.feedAdapters];
  const emails = (d.pushedEmails ?? []).map((p) => p.email);
  if (emails.length) {
    const gmail: GmailResult = {
      connected: true,
      listRecent: async () => emails,
      createDraft: async () => { throw new Error("read-only pushed emails"); },
      send: async () => { throw new Error("read-only pushed emails"); },
    };
    for (const id of ["handshake", "twelve_twenty", "linkedin_alert", "indeed_alert"] as const) adapters.push(createEmailAdapter(id, { getGmail: () => gmail }));
  }

  const run = await runDiscovery(d.ctx, { adapters, healthStore: d.healthStore, concurrency: 4 });
  const res: DiscoveryPhaseResult = { found: run.jobs.length, created: 0, existing: 0, duplicates: 0, unresolved: 0, qualified: 0, review: 0, archived: 0, failed: 0, sourceErrors: [], emailsProcessed: emails.length };
  for (const s of run.sources) if (s.error) res.sourceErrors.push(`${s.source}: ${s.error.slice(0, 160)}`);

  await pool(run.jobs as DiscoveredJob[], d.concurrency ?? 4, async (job) => {
    try {
      const r = await ingestDiscovered(d.store, d.ctx, job, d.prefs, { now: d.now?.(), enrich: d.enrich });
      if (r.outcome === "existing") res.existing++;
      else if (r.outcome === "duplicate") res.duplicates++;
      else {
        res.created++; if (r.outcome === "unresolved") res.unresolved++;
        if (r.decision === "qualify") res.qualified++; else if (r.decision === "needs_review") res.review++; else res.archived++;
      }
    } catch (e) { res.failed++; d.log(`ingest failed for ${job.job.company} | ${job.job.title}: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`); }
  });
  d.log(`discovery: ${res.found} found, ${res.created} new (${res.qualified} qualified, ${res.review} review, ${res.archived} archived), ${res.existing} already known, ${res.duplicates} duplicates, ${res.failed} failed`);
  return res;
}

// ====================================================================== phase B: enqueue apply tasks under policy + daily cap
export interface EnqueueDeps {
  store: Store; queue: TaskQueue; ctx: Ctx; prefs: Preferences; log: (m: string) => void;
  /** applications created since `since` (any status): counts toward maxApplicationsPerDay */
  countAppsToday: (ctx: Ctx, since: Date) => Promise<number>;
  forceDryRun?: boolean; now?: () => Date;
}
export interface EnqueueResult { mode: "live" | "dry_run"; candidates: number; enqueued: number; existing: number; capRemaining: number; cappedOut: number }

export async function enqueueApplyPhase(d: EnqueueDeps): Promise<EnqueueResult> {
  const now = (d.now ?? (() => new Date()))();
  const policy = d.prefs.policy;
  const live = !d.forceDryRun && policy.mode === "live" && policy.autoApply;
  const mode = live ? "live" : "dry_run";

  const rows = await d.store.searchJobs(d.ctx, { limit: 500 });
  const cands: Array<{ id: string; priority: number; ats: AtsKind; label: string }> = [];
  for (const j of rows) {
    const n = j.normalized;
    if (!SUPPORTED_ATS.has(n.atsKind) || !n.applyUrl) continue;
    if (j.stage === "needs_human" || j.stage === "duplicate" || j.stage === "archived" || j.stage === "applied") continue;
    const tracked = (n as unknown as { tracking?: { status?: string | null } }).tracking?.status ?? null;
    const explicit = tracked === "queued";                       // the user put it in the auto-apply queue
    const auto = !tracked && j.stage === "qualified" && policy.autoApply && (j.score?.total ?? 0) >= policy.minScoreToApply;
    if (!explicit && !auto) continue;
    const app = await d.store.getApplicationByJob(d.ctx, j.id);
    if (app && (app.confirmed || app.status === "unverified" || app.status === "succeeded" || app.status === "failed")) continue;
    if (app?.status === "dry_run" && mode === "dry_run") continue; // already dry-run checked
    cands.push({ id: j.id, ats: n.atsKind, label: `${n.company} | ${n.title}`, priority: (explicit ? 1000 : 0) + deadlinePriority(n.deadline, now) + Math.floor((j.score?.total ?? 0) / 20) });
  }
  cands.sort((a, b) => b.priority - a.priority);

  const queued = (await d.queue.list(d.ctx, { kind: "apply", status: "queued", limit: 200 })).length;
  const used = (await d.countAppsToday(d.ctx, startOfUtcDay(now))) + queued;
  const capRemaining = Math.max(0, policy.maxApplicationsPerDay - used);
  const take = cands.slice(0, capRemaining);

  let enqueued = 0, existing = 0;
  for (const c of take) {
    const r = await d.queue.enqueue(d.ctx, { kind: "apply", idempotencyKey: `apply:${c.id}:${mode}`, priority: c.priority, maxAttempts: 1, payload: { jobId: c.id, mode, ats: c.ats } });
    if (r.created) enqueued++; else existing++;
  }
  d.log(`apply queue (${mode}): ${cands.length} candidate(s), ${enqueued} enqueued, ${existing} already queued, cap remaining ${capRemaining}/${policy.maxApplicationsPerDay}`);
  return { mode, candidates: cands.length, enqueued, existing, capRemaining, cappedOut: Math.max(0, cands.length - take.length) };
}

// ====================================================================== phase C: apply handler
export interface ApplicantBundle { profile: CandidateProfile; resumes: AssetBundle["resumes"]; aboutPath: string }
export interface ApplyResultRecord { jobId: string; company: string; title: string; ats: string; outcome: string; failure?: string }

export interface ApplyHandlerDeps {
  store: Store; usage: UsageRecorder; drafts: DraftCache; templates?: FormTemplateStore;
  bundleFor(ctx: Ctx): Promise<ApplicantBundle>;
  /** Persists the user-facing tracking state (apps/web/src/lib/tracking.ts setTracking in the real worker). */
  tracking(ctx: Ctx, jobId: string, patch: { status?: string | null; notes?: string }): Promise<void>;
  uploadEvidence?(ctx: Ctx, jobId: string, png: Buffer): Promise<void>;
  openPage?: ApplyDeps["openPage"]; llm?: LlmFn;
  /** ATS adapters trusted for LIVE submission. Only Greenhouse has been exercised on a real form. */
  verified?: Set<AtsKind>;
  limits?: PipelineLimits; forceDryRun?: boolean;
  log: (m: string) => void; onResult?: (r: ApplyResultRecord) => void;
  now?: () => Date;
  /** Readers for the resume .docx (default: real `unzip`-based readers). Injectable for tests. */
  readDocxText?: (docx: string) => string; readHighlights?: (docx: string) => string[];
}

/** A Store view whose saved policy reads as dry_run, so an adapter never raises 'live requested but unverified' noise on a dry run. */
function withDryRunPolicy(store: Store): Store {
  const view = Object.create(store) as Store;
  view.getPreferences = async (ctx: Ctx) => {
    const p = await store.getPreferences(ctx);
    return { ...p, policy: { ...p.policy, mode: "dry_run", autoApply: false } };
  };
  return view;
}

export function createApplyHandler(d: ApplyHandlerDeps): TaskHandler {
  const limits = d.limits ?? DEFAULT_LIMITS;
  const verified = d.verified ?? new Set<AtsKind>(["greenhouse"]);
  const stamp = () => (d.now?.() ?? new Date()).toISOString().slice(0, 10);

  return async (task: Task, helpers) => {
    const ctx = task.ctx;
    const jobId = String(task.payload.jobId ?? "");
    if (!jobId) throw new NonRetryableError("apply task has no jobId");
    const job = await d.store.getJob(ctx, jobId);
    if (!job) throw new NonRetryableError("job not found");
    const n = job.normalized;
    const rec = (outcome: string, failure?: string): ApplyResultRecord => ({ jobId, company: n.company, title: n.title, ats: n.atsKind, outcome, ...(failure ? { failure } : {}) });

    const existing = await d.store.getApplicationByJob(ctx, jobId);
    if (existing?.confirmed) { const r = rec("already_applied"); d.onResult?.(r); return { outcome: "already_applied" }; }
    if (existing?.status === "unverified") { d.log(`job ${jobId.slice(0, 8)}: earlier submit unverified; not retrying`); const r = rec("skipped_unverified"); d.onResult?.(r); return { outcome: "skipped_unverified" }; }

    const prefs = await d.store.getPreferences(ctx);
    const live = !d.forceDryRun && task.payload.mode === "live" && prefs.policy.mode === "live" && prefs.policy.autoApply;
    const bundle = await d.bundleFor(ctx);
    const base = pickResumeBase(n.roleCategory ?? "other", n.title);
    const resume = bundle.resumes[base];

    if (live) {
      const hl = (d.readHighlights ?? highlightedText)(resume.docx);
      if (hl.length) {
        await d.store.raiseException(ctx, { ctx, type: "low_factual_confidence", entityType: "job", entityId: jobId, detail: `The ${base} resume has ${hl.length} unconfirmed (highlighted) item(s). Live submission is refused until they are confirmed.` });
        d.log(`job ${jobId.slice(0, 8)}: blocked, ${base} resume has unconfirmed highlighted text`);
        const r = rec("blocked", "unconfirmed_resume_text"); d.onResult?.(r);
        return { outcome: "blocked", failure: "unconfirmed_resume_text" };
      }
    }

    d.log(`apply ${live ? "LIVE" : "dry-run"}: ${n.company} | ${n.title} [${n.atsKind}] job ${jobId.slice(0, 8)} resume ${base}`);
    const meter = new UsageMeter();
    setLlmUsageSink(meter.sink);
    const t0 = Date.now();
    let rep: ApplyReport;
    try {
      rep = await applyToJob(live ? d.store : withDryRunPolicy(d.store), ctx, jobId, {
        profile: bundle.profile, resumePdfPath: resume.pdf, templates: d.templates, limits,
        remainingAiUsd: helpers.aiAllowed() ? limits.perApplicationAiUsd : 0,
        verifiedAdapters: live ? verified : new Set<AtsKind>(),
        openPage: d.openPage, llm: d.llm,
        draftEssay: async (q) => {
          const cache = await d.drafts.get(jobId);
          if (!cache[q.question]) {
            if (!helpers.aiAllowed()) { d.log(`job ${jobId.slice(0, 8)}: AI budget reached, essay left for the user`); return null; }
            const about = `${readFileSync(bundle.aboutPath, "utf8")}\n\n<resume>\n${(d.readDocxText ?? docxText)(resume.docx)}\n</resume>`;
            const t = await draftEssayAnswer({ ...q, about }, d.llm);
            if (!t) return null;
            cache[q.question] = { text: t, approved: !q.aiRestricted };
            await d.drafts.put(jobId, cache);
          }
          const x = cache[q.question]!;
          return { text: x.text, approved: x.approved && !q.aiRestricted };
        },
        afterSubmit: async (page) => {
          if (!d.uploadEvidence) return;
          const png = await page.screenshot({ fullPage: true });
          await d.uploadEvidence(ctx, jobId, Buffer.from(png)).catch(() => undefined);
        },
      });
    } finally { setLlmUsageSink(null); }

    const seconds = rep.attempt?.seconds ?? (Date.now() - t0) / 1000;
    const failure = rep.result.exception?.type;

    // Confirmation evidence is kept without anything personal: host + a short matched snippet only.
    if (rep.outcome === "submitted_confirmed" && rep.applicationId && rep.result.confirmationEvidence) {
      const ev = rep.result.confirmationEvidence;
      let host = ""; try { host = new URL(ev.url ?? "").host; } catch { /* no url */ }
      await d.store.updateApplication(ctx, rep.applicationId, { evidence: { kind: ev.kind, detail: String(ev.detail ?? "").slice(0, 120), host } });
    }

    const oldNotes = String((n as unknown as { tracking?: { notes?: string } }).tracking?.notes ?? "");
    const note = (m: string) => (oldNotes ? `${oldNotes}\n` : "") + `[cloud ${stamp()}] ${m}`;
    switch (rep.outcome) {
      case "submitted_confirmed": await d.tracking(ctx, jobId, { status: "applied", notes: note("submitted; confirmation page seen") }); break;
      case "already_applied": await d.tracking(ctx, jobId, { status: "applied" }); break;
      case "dry_run": case "live_gated": await d.tracking(ctx, jobId, { notes: note(`dry run: form filled (${rep.filled.length} fields); not submitted`) }); break;
      case "submitted_unverified": await d.tracking(ctx, jobId, { notes: note("submit clicked, confirmation not seen; not retried. Check your email/portal") }); break;
      default: await d.tracking(ctx, jobId, { status: "saved", notes: note(`could not finish (${rep.outcome}${failure ? `: ${failure}` : ""}); see Inbox`) });
    }

    const rows = [
      ...meter.toRows(),
      { metric: "browser.runs", quantity: 1, ref: "measured" },
      { metric: "applications.attempted", quantity: 1, ref: "measured" },
      ...(rep.outcome === "submitted_confirmed" ? [{ metric: "applications.confirmed", quantity: 1, ref: "measured" }] : []),
      ...(rep.outcome === "submitted_unverified" ? [{ metric: "applications.unverified", quantity: 1, ref: "measured" }] : []),
      ...(rep.outcome === "dry_run" || rep.outcome === "live_gated" ? [{ metric: "applications.dry_run", quantity: 1, ref: "measured" }] : []),
      ...(["blocked", "unsupported"].includes(rep.outcome) ? [{ metric: "applications.failed", quantity: 1, ref: "measured" }] : []),
    ];
    await d.usage.record(ctx, rows).catch((e) => d.log(`usage write failed: ${e instanceof Error ? e.message.slice(0, 100) : "error"}`));
    // The application already happened: a budget error here must not turn a real submission into a failed task.
    try { helpers.addCost(meter.costUsd); } catch (e) { d.log(`budget note: ${(e as Error).message.slice(0, 120)}`); }

    d.log(`result ${jobId.slice(0, 8)}: ${rep.outcome}${failure ? ` (${failure})` : ""} in ${seconds.toFixed(0)}s, ${meter.calls} model call(s), ${rep.filled.length} field(s)`);
    d.onResult?.(rec(rep.outcome, failure));
    return {
      outcome: rep.outcome, strategy: rep.attempt?.strategy ?? "deterministic", seconds: Math.round(seconds * 10) / 10,
      modelCalls: meter.calls, costUsd: Math.round(meter.costUsd * 1e6) / 1e6,
      fieldsFilled: rep.attempt?.fieldsFilled ?? rep.filled.length, fieldsExpected: rep.attempt?.fieldsExpected ?? rep.filled.length,
      ats: n.atsKind, ...(failure ? { failure } : {}),
    };
  };
}

export interface ApplyPhaseDeps {
  queue: TaskQueue; handler: TaskHandler; workerId: string; host?: string; spend?: SpendReader; limits?: PipelineLimits;
  /** stop starting new tasks at this instant (a running task still finishes within its own browser-time limit) */
  deadline: Date; log: (m: string) => void; now?: () => Date;
}

export async function runApplyPhase(d: ApplyPhaseDeps) {
  const ac = new AbortController();
  const ms = Math.max(0, d.deadline.getTime() - (d.now?.() ?? new Date()).getTime());
  const timer = setTimeout(() => ac.abort(), ms);
  const onEvent = (e: WorkerEvent) => {
    const id = "task" in e ? e.task.id.slice(0, 8) : "";
    if (e.type === "task_failed") d.log(`task ${id} failed${e.retry ? " (will retry)" : ""}: ${e.error.slice(0, 120)}`);
    else if (e.type === "budget_exceeded") d.log(`task ${id} stopped by ${e.scope} budget`);
    else if (e.type === "timeout") d.log(`task ${id} exceeded ${e.seconds}s browser limit`);
    else if (e.type === "lease_lost") d.log(`task ${id} lease lost`);
  };
  try {
    return await runWorker({
      queue: d.queue, handlers: { apply: d.handler }, kinds: ["apply"], workerId: d.workerId, host: d.host,
      drain: true, signal: ac.signal, concurrency: 1, leaseSeconds: 360, limits: d.limits ?? DEFAULT_LIMITS, spend: d.spend, onEvent,
    });
  } finally { clearTimeout(timer); }
}

// ====================================================================== phase D: summary + notification
export interface RunSummary {
  dryRun: boolean; discovery?: DiscoveryPhaseResult; enqueue?: EnqueueResult;
  results: ApplyResultRecord[]; failedTasks: number;
}

export function buildNotification(s: RunSummary, appUrl?: string): Notification | null {
  if (s.dryRun) return null;                                         // manual dry runs are for the person watching
  const confirmed = s.results.filter((r) => r.outcome === "submitted_confirmed");
  const unverified = s.results.filter((r) => r.outcome === "submitted_unverified");
  const blocked = s.results.filter((r) => r.outcome === "blocked" || r.outcome === "unsupported");
  const auth = s.results.filter((r) => r.failure === "auth_required");
  const attention = unverified.length + blocked.length + s.failedTasks + auth.length;
  if (confirmed.length === 0 && attention === 0) return null;       // quiet when nothing noteworthy happened

  const parts: string[] = [];
  if (confirmed.length) parts.push(`${confirmed.length} application${confirmed.length > 1 ? "s" : ""} confirmed`);
  if (auth.length) parts.push(`${auth.length} need a sign-in`);
  if (unverified.length) parts.push(`${unverified.length} sent but unconfirmed`);
  if (blocked.length) parts.push(`${blocked.length} blocked`);
  if (s.failedTasks) parts.push(`${s.failedTasks} failed`);
  const lines = [...confirmed.map((r) => `Confirmed: ${r.company}, ${r.title}`), ...[...unverified, ...blocked, ...auth].map((r) => `Needs you: ${r.company}, ${r.title}`)].slice(0, 4);
  return {
    kind: attention ? "exception" : "application_confirmed",
    title: `Recruiting OS: ${parts.join(", ")}`,
    body: lines.join("\n") || parts.join(", "),
    ...(appUrl ? { url: `${appUrl.replace(/\/$/, "")}/inbox` } : {}),
  };
}
