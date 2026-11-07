// Pure helpers for the V3 dashboard: lifecycle phase derivation, worker status, queue depth, apply success math.
// No I/O here. Everything is derived from rows the caller read from Supabase, so nothing can show fake progress.
import type { JobStage } from "@ros/core";

export const PHASES = ["DISCOVER", "QUALIFY", "TAILOR", "APPLY", "CONNECT", "INTERVIEW", "OFFER"] as const;
export type Phase = (typeof PHASES)[number];
export type PhaseOrClosed = Phase | "CLOSED";

export const PHASE_LABEL: Record<Phase, string> = {
  DISCOVER: "Discover", QUALIFY: "Qualify", TAILOR: "Tailor", APPLY: "Apply", CONNECT: "Connect", INTERVIEW: "Interview", OFFER: "Offer",
};

export interface TaskLite {
  id: string; kind: string; status: string; jobId: string | null; lastError: string | null;
  result: Record<string, unknown> | null; workerId: string | null; updatedAt: string | null; costUsd: number;
}

const ACTIVE = new Set(["queued", "leased"]);

export interface PhaseInput { stage: JobStage; trackingStatus: string | null; tasks: Array<Pick<TaskLite, "kind" | "status">> }

/** Where a job is in DISCOVER -> QUALIFY -> TAILOR -> APPLY -> CONNECT -> INTERVIEW -> OFFER (or CLOSED). */
export function derivePhase(i: PhaseInput): PhaseOrClosed {
  const t = i.trackingStatus;
  if (t === "offer" || i.stage === "offer") return "OFFER";
  if (t === "interviewing" || i.stage === "interviewing") return "INTERVIEW";
  if (t === "rejected" || i.stage === "rejected" || i.stage === "withdrawn") return "CLOSED";
  if ((i.stage === "archived" || i.stage === "duplicate") && !t) return "CLOSED";
  if (t === "applied" || t === "ready_to_contact" || i.stage === "applied") return "CONNECT";
  const active = i.tasks.filter((x) => ACTIVE.has(x.status));
  if (active.some((x) => x.kind === "apply" || x.kind === "verify")) return "APPLY";
  if (active.some((x) => x.kind === "outreach")) return "CONNECT";
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
    case "OFFER": return "Review and respond to the offer.";
    case "INTERVIEW": return "Prepare for the interview.";
    case "CONNECT":
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
  const out: Record<PhaseOrClosed, number> = { DISCOVER: 0, QUALIFY: 0, TAILOR: 0, APPLY: 0, CONNECT: 0, INTERVIEW: 0, OFFER: 0, CLOSED: 0 };
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
