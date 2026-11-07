// Pure helpers for the dashboard: lifecycle phase derivation, worker status, queue depth, apply success math, usage and limits,
// run summary, exception actions. No I/O here. Everything is derived from rows the caller read from Supabase, so nothing can show fake progress.
import type { JobStage } from "@ros/core";

export const PHASES = ["DISCOVER", "QUALIFY", "TAILOR", "APPLY", "SUBMITTED", "FOLLOW_UP"] as const;
export type Phase = (typeof PHASES)[number];
export type PhaseOrClosed = Phase | "CLOSED";

export const PHASE_LABEL: Record<Phase, string> = {
  DISCOVER: "Discover", QUALIFY: "Qualify", TAILOR: "Tailor", APPLY: "Apply", SUBMITTED: "Submitted", FOLLOW_UP: "Follow-up",
};

export interface TaskLite {
  id: string; kind: string; status: string; jobId: string | null; lastError: string | null;
  result: Record<string, unknown> | null; workerId: string | null; updatedAt: string | null; costUsd: number;
}

const ACTIVE = new Set(["queued", "leased"]);

export interface PhaseInput { stage: JobStage; trackingStatus: string | null; tasks: Array<Pick<TaskLite, "kind" | "status">> }

/**
 * Where a job is in DISCOVER -> QUALIFY -> TAILOR -> APPLY -> SUBMITTED -> FOLLOW-UP (or CLOSED).
 * SUBMITTED = applied (including "ready to contact"). FOLLOW-UP = interviews, offers and active outreach.
 */
export function derivePhase(i: PhaseInput): PhaseOrClosed {
  const t = i.trackingStatus;
  if (t === "offer" || i.stage === "offer") return "FOLLOW_UP";
  if (t === "interviewing" || i.stage === "interviewing") return "FOLLOW_UP";
  if (t === "rejected" || i.stage === "rejected" || i.stage === "withdrawn") return "CLOSED";
  if ((i.stage === "archived" || i.stage === "duplicate") && !t) return "CLOSED";
  const active = i.tasks.filter((x) => ACTIVE.has(x.status));
  if (t === "applied" || t === "ready_to_contact" || i.stage === "applied") {
    return active.some((x) => x.kind === "outreach") ? "FOLLOW_UP" : "SUBMITTED";
  }
  if (active.some((x) => x.kind === "apply" || x.kind === "verify")) return "APPLY";
  if (active.some((x) => x.kind === "outreach")) return "FOLLOW_UP";
  if (active.some((x) => x.kind === "tailor")) return "TAILOR";
  if (t === "queued" || i.stage === "applying" || i.stage === "needs_human") return "APPLY";
  if (t === "saved") return "QUALIFY";
  if (i.stage === "qualified" || i.stage === "scored" || i.stage === "researched") return "QUALIFY";
  return "DISCOVER";
}

export interface NextActionInput {
  phase: PhaseOrClosed; stage: JobStage; trackingStatus: string | null;
  hasOpenException: boolean; activeTaskKind: string | null; confirmed: boolean;
}

export function nextAction(i: NextActionInput): string {
  if (i.phase === "CLOSED") return "None. This job is closed.";
  if (i.hasOpenException) return "Answer the open item in your inbox.";
  if (i.activeTaskKind) return `Wait: ${i.activeTaskKind} is in progress.`;
  switch (i.phase) {
    case "FOLLOW_UP":
      if (i.trackingStatus === "offer" || i.stage === "offer") return "Review and respond to the offer.";
      if (i.trackingStatus === "interviewing" || i.stage === "interviewing") return "Prepare for the interview.";
      return "Follow up on your outreach.";
    case "SUBMITTED":
      return i.trackingStatus === "applied" && !i.confirmed
        ? "Check your email or the company portal for a confirmation."
        : "Reach out to people at the company.";
    case "APPLY":
      return i.stage === "needs_human" ? "Finish the application yourself." : "Waiting for the apply worker.";
    case "TAILOR": return "Waiting for the tailored resume.";
    case "QUALIFY":
      return i.trackingStatus === "saved" ? "Queue it to auto-apply or apply manually." : "Review it: save it or queue it to auto-apply.";
    default: return "Waiting for scoring.";
  }
}

export function phaseCounts(phases: PhaseOrClosed[]): Record<PhaseOrClosed, number> {
  const out: Record<PhaseOrClosed, number> = { DISCOVER: 0, QUALIFY: 0, TAILOR: 0, APPLY: 0, SUBMITTED: 0, FOLLOW_UP: 0, CLOSED: 0 };
  for (const p of phases) out[p]++;
  return out;
}

// ------------------------------------------------------------------ workers
export const WORKER_STALE_MS = 120_000;

/** A worker is online only if it heartbeated within the last two minutes. */
export function workerStatus(lastSeenIso: string | null, now: number = Date.now(), staleMs: number = WORKER_STALE_MS): "online" | "offline" {
  if (!lastSeenIso) return "offline";
  const t = Date.parse(lastSeenIso);
  if (Number.isNaN(t)) return "offline";
  return now - t <= staleMs ? "online" : "offline";
}

// ------------------------------------------------------------------ queue + apply stats
export interface QueueDepth { queued: number; leased: number; done: number; failed: number; dead: number }

export function queueDepth(tasks: Array<{ status: string }>): QueueDepth {
  const out: QueueDepth = { queued: 0, leased: 0, done: 0, failed: 0, dead: 0 };
  for (const t of tasks) if (t.status in out) out[t.status as keyof QueueDepth]++;
  return out;
}

/** Whole-number percentage, or null when nothing has been attempted (never a fake 0%). */
export function successRate(confirmed: number, attempted: number): number | null {
  return attempted > 0 ? Math.round((100 * confirmed) / attempted) : null;
}

export interface ApplyRecord { status: string; confirmed: boolean; provider: string | null; strategy: string | null }
export interface Bucket { attempted: number; confirmed: number; rate: number | null }
export interface ApplyStats {
  attempted: number; confirmed: number; unverified: number; failed: number; successRate: number | null;
  byProvider: Record<string, Bucket>; byStrategy: Record<string, Bucket>;
}

/** Attempts = confirmed + unverified + failed. Dry runs and pending rows are not attempts. */
export function summarizeApplyStats(recs: ApplyRecord[]): ApplyStats {
  const stats: ApplyStats = { attempted: 0, confirmed: 0, unverified: 0, failed: 0, successRate: null, byProvider: {}, byStrategy: {} };
  const bump = (m: Record<string, Bucket>, key: string, ok: boolean) => {
    const b = (m[key] ??= { attempted: 0, confirmed: 0, rate: null });
    b.attempted++; if (ok) b.confirmed++;
    b.rate = successRate(b.confirmed, b.attempted);
  };
  for (const r of recs) {
    const confirmed = r.status === "succeeded" && r.confirmed;
    const unverified = r.status === "unverified" || (r.status === "succeeded" && !r.confirmed);
    const failed = r.status === "failed";
    if (!confirmed && !unverified && !failed) continue;
    stats.attempted++;
    if (confirmed) stats.confirmed++; else if (unverified) stats.unverified++; else stats.failed++;
    bump(stats.byProvider, r.provider ?? "unknown", confirmed);
    bump(stats.byStrategy, r.strategy ?? "unknown", confirmed);
  }
  stats.successRate = successRate(stats.confirmed, stats.attempted);
  return stats;
}

// ------------------------------------------------------------------ source labels
export const SOURCE_LABEL: Record<string, string> = {
  handshake: "Handshake alerts", twelve_twenty: "12twenty alerts", linkedin_alert: "LinkedIn alerts", indeed_alert: "Indeed alerts",
  greenhouse: "Greenhouse feeds", lever: "Lever feeds", ashby: "Ashby feeds", remote_feed: "Remote job feeds",
  manual: "Manual add", csv: "CSV/XLSX import", whatsapp: "WhatsApp export",
  // ingestion.source values written by the existing pipeline
  ats_feed: "Public job boards", manual_url: "Manual add (URL)", manual_text: "Manual add (text)", gmail_alert: "Email alert",
  spreadsheet_upload: "Spreadsheet upload", whatsapp_export: "WhatsApp export", career_page: "Career page", mcp: "MCP",
};
export const sourceLabel = (s: string): string => SOURCE_LABEL[s] ?? s.replace(/_/g, " ");

export type StatusTone = "neutral" | "good" | "warn" | "bad";
export function sourceTone(status: string): StatusTone {
  return status === "ok" ? "good" : status === "degraded" ? "warn" : status === "failed" ? "bad" : "neutral";
}
export function sourceStatusLabel(status: string): string {
  return status === "ok" ? "Healthy" : status === "degraded" ? "Degraded" : status === "failed" ? "Failing" : "Not configured";
}

// ------------------------------------------------------------------ run summary (Today page)
export interface RunSummaryInput {
  sources: Array<{ lastAttemptAt: string | null; itemsLastRun: number }>;
  discoverTasks: Array<{ status: string; updatedAt: string | null }>;
  applyTasks: Array<{ status: string }>;
  apps: Array<{ status: string; confirmed: boolean }>;
  openExceptions: number;
}
export interface RunSummary {
  lastDiscoveryAt: string | null; jobsFoundLastRun: number;
  applyQueued: number; applyRunning: number;
  confirmed: number; unverified: number; failed: number; openExceptions: number;
  /** True once anything has run through the automated pipeline; otherwise the UI shows an honest empty state. */
  hasRun: boolean;
}

const latest = (isos: Array<string | null>): string | null => {
  let best: string | null = null; let bestT = -Infinity;
  for (const s of isos) { if (!s) continue; const t = Date.parse(s); if (!Number.isNaN(t) && t > bestT) { bestT = t; best = s; } }
  return best;
};

export function summarizeRun(i: RunSummaryInput): RunSummary {
  const stats = summarizeApplyStats(i.apps.map((a) => ({ status: a.status, confirmed: a.confirmed, provider: null, strategy: null })));
  const lastDiscoveryAt = latest([...i.sources.map((s) => s.lastAttemptAt), ...i.discoverTasks.filter((t) => t.status === "done").map((t) => t.updatedAt)]);
  const applyQueued = i.applyTasks.filter((t) => t.status === "queued").length;
  const applyRunning = i.applyTasks.filter((t) => t.status === "leased").length;
  return {
    lastDiscoveryAt, jobsFoundLastRun: i.sources.reduce((n, s) => n + s.itemsLastRun, 0),
    applyQueued, applyRunning, confirmed: stats.confirmed, unverified: stats.unverified, failed: stats.failed, openExceptions: i.openExceptions,
    hasRun: lastDiscoveryAt != null || applyQueued + applyRunning > 0 || stats.attempted > 0 || i.discoverTasks.length > 0,
  };
}

// ------------------------------------------------------------------ usage + limits
export interface UsageRow { metric: string; quantity: number; costUsd: number; ref: string | null; createdAt: string }
export interface UsageTotals { calls: number; inputTokens: number; outputTokens: number; costUsd: number }
export interface UsageSummary {
  /** Values written by real model calls. */
  measured: UsageTotals;
  /** Rows explicitly tagged ref='estimate'. Never mixed into measured. */
  estimated: UsageTotals;
  today: { measuredUsd: number; estimatedUsd: number };
  month: { measuredUsd: number; estimatedUsd: number };
}

const emptyTotals = (): UsageTotals => ({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
const startOfUtcDay = (now: number) => { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
const startOfUtcMonth = (now: number) => { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };

/** Calls come from 'llm.calls' rows; if none exist, each 'llm.output_tokens' row is one recorded call. */
export function summarizeUsage(rows: UsageRow[], now: number = Date.now()): UsageSummary {
  const out: UsageSummary = { measured: emptyTotals(), estimated: emptyTotals(), today: { measuredUsd: 0, estimatedUsd: 0 }, month: { measuredUsd: 0, estimatedUsd: 0 } };
  const dayStart = startOfUtcDay(now), monthStart = startOfUtcMonth(now);
  const hasCallRows = rows.some((r) => r.metric === "llm.calls");
  for (const r of rows) {
    const est = r.ref === "estimate";
    const bucket = est ? out.estimated : out.measured;
    const qty = Number.isFinite(r.quantity) ? r.quantity : 0;
    const cost = Number.isFinite(r.costUsd) ? r.costUsd : 0;
    if (r.metric === "llm.calls") bucket.calls += qty;
    else if (r.metric === "llm.output_tokens") { bucket.outputTokens += qty; if (!hasCallRows) bucket.calls += 1; }
    else if (r.metric === "llm.input_tokens") bucket.inputTokens += qty;
    bucket.costUsd += cost;
    const t = Date.parse(r.createdAt);
    if (!Number.isNaN(t)) {
      if (t >= dayStart) { if (est) out.today.estimatedUsd += cost; else out.today.measuredUsd += cost; }
      if (t >= monthStart) { if (est) out.month.estimatedUsd += cost; else out.month.measuredUsd += cost; }
    }
  }
  return out;
}

export interface LimitsLike { dailyAiUsd: number; monthlyAiUsd: number; perApplicationAiUsd: number; maxFallbackAttempts: number; maxBrowserSeconds: number }

/** Overlay positive numeric values from stored preferences (profiles.preferences.limits) onto the defaults. */
export function mergeLimits(raw: unknown, base: LimitsLike): LimitsLike {
  const out: LimitsLike = { ...base };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(base) as Array<keyof LimitsLike>) {
    const v = r[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

export function spendStatus(spentUsd: number, limitUsd: number): { pct: number | null; level: "ok" | "warn" | "over" } {
  if (!(limitUsd > 0)) return { pct: null, level: "ok" };
  const level = spentUsd >= limitUsd ? "over" : spentUsd >= 0.8 * limitUsd ? "warn" : "ok";
  return { pct: Math.min(100, Math.round((100 * spentUsd) / limitUsd)), level };
}

/** The three n8n workflows and how often they are scheduled. n8n exposes no usage to us, so every number derived from this is an ESTIMATE. */
export const N8N_SCHEDULES: Array<{ name: string; runsPerDay: number }> = [
  { name: "Daily discovery batch", runsPerDay: 1 },
  { name: "Daily processing batch", runsPerDay: 1 },
  { name: "Gmail sync and follow-ups (every 3 hours)", runsPerDay: 8 },
];
export function estimateN8nExecutions(schedules: Array<{ name: string; runsPerDay: number }> = N8N_SCHEDULES) {
  const perDay = schedules.reduce((n, s) => n + s.runsPerDay, 0);
  return { perDay, perMonth: perDay * 30, workflows: schedules };
}

// ------------------------------------------------------------------ browser runs (from apply tasks)
export function summarizeBrowserRuns(tasks: Array<{ status: string }>) {
  const finished = tasks.filter((t) => t.status === "done" || t.status === "failed" || t.status === "dead");
  const succeeded = finished.filter((t) => t.status === "done").length;
  return { runs: finished.length, succeeded, failed: finished.length - succeeded };
}

// ------------------------------------------------------------------ exception actions (Inbox)
export interface ExceptionLike { entityType: string; entityId: string | null }

/** The job an exception belongs to: directly for job exceptions, via the application for application exceptions, otherwise none. */
export function exceptionJobId(e: ExceptionLike, jobOfApplication: ReadonlyMap<string, string>): string | null {
  if (!e.entityId) return null;
  if (e.entityType === "job") return e.entityId;
  if (e.entityType === "application") return jobOfApplication.get(e.entityId) ?? null;
  return null;
}

export type RetryCheck = { ok: true } | { ok: false; reason: "already_confirmed" | "unverified_submission" };

/** A confirmed application is never retried; an unverified one may already have gone through, so it is never auto-retried either. */
export function retryEligibility(app: { status: string; confirmed: boolean } | null): RetryCheck {
  if (app?.confirmed) return { ok: false, reason: "already_confirmed" };
  if (app?.status === "unverified") return { ok: false, reason: "unverified_submission" };
  return { ok: true };
}

/** apply:<jobId>:retry:<n> with n one past the highest retry already used for this job. */
export function nextRetryKey(jobId: string, existingKeys: string[]): string {
  const prefix = `apply:${jobId}:retry:`;
  let max = 0;
  for (const k of existingKeys) {
    if (!k.startsWith(prefix)) continue;
    const n = Number(k.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}${max + 1}`;
}
