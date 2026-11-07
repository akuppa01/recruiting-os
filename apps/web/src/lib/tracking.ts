// Manual application tracking. Stored inside jobs.normalized.tracking (no schema change needed), scoped by tenant+user on every write.
import type { Ctx, JobStage, Store } from "@ros/core";
import { SupabaseStore } from "@ros/db";

export const TRACK_STATUSES = ["saved", "queued", "applied", "ready_to_contact", "interviewing", "rejected", "offer"] as const;
export type TrackStatus = (typeof TRACK_STATUSES)[number];

export interface Tracking { status: TrackStatus | null; notes: string; followUpAt: string | null; appliedAt: string | null }
export const EMPTY_TRACKING: Tracking = { status: null, notes: "", followUpAt: null, appliedAt: null };

const STAGE_FOR: Partial<Record<TrackStatus, JobStage>> = { queued: "applying", applied: "applied", ready_to_contact: "applied", interviewing: "interviewing", offer: "offer", rejected: "rejected" };

/* eslint-disable @typescript-eslint/no-explicit-any */
export function readTracking(normalized: unknown): Tracking {
  const t = (normalized as any)?.tracking;
  if (!t || typeof t !== "object") return { ...EMPTY_TRACKING };
  return {
    status: TRACK_STATUSES.includes(t.status) ? t.status : null,
    notes: typeof t.notes === "string" ? t.notes : "",
    followUpAt: typeof t.followUpAt === "string" ? t.followUpAt : null,
    appliedAt: typeof t.appliedAt === "string" ? t.appliedAt : null,
  };
}

export async function setTracking(
  store: Store, ctx: Ctx, jobId: string,
  patch: { status?: TrackStatus | null; notes?: string; followUpAt?: string | null },
): Promise<Tracking | null> {
  if (!(store instanceof SupabaseStore)) throw new Error("Tracking requires Supabase (not available in demo mode)");
  const job = await store.getJob(ctx, jobId);
  if (!job) return null;

  const cur = readTracking(job.normalized);
  let status = patch.status !== undefined ? patch.status : cur.status;
  // Queued jobs that reach Applied move straight on to "ready to contact".
  if (patch.status === "applied" && cur.status === "queued") status = "ready_to_contact";
  const next: Tracking = {
    status,
    notes: patch.notes !== undefined ? patch.notes : cur.notes,
    followUpAt: patch.followUpAt !== undefined ? patch.followUpAt : cur.followUpAt,
    appliedAt: cur.appliedAt,
  };
  const becameApplied = (status === "applied" || status === "ready_to_contact") && !cur.appliedAt;
  if (becameApplied) next.appliedAt = new Date().toISOString();

  const { error } = await store.sb.from("jobs")
    .update({ normalized: { ...(job.normalized as object), tracking: next } })
    .eq("tenant_id", ctx.tenantId).eq("user_id", ctx.userId).eq("id", jobId);
  if (error) throw new Error(`setTracking: ${error.message}`);

  const stage = next.status ? STAGE_FOR[next.status] : undefined;
  if (stage && patch.status !== undefined && stage !== job.stage) await store.setJobStage(ctx, jobId, stage);

  if (becameApplied) {
    const { app } = await store.getOrCreateApplication(ctx, jobId);
    await store.updateApplication(ctx, app.id, {
      status: "succeeded", confirmed: true, submittedAt: next.appliedAt,
      evidence: { kind: "user_attested", detail: "Marked as applied by you" },
    });
  }
  if (next.status !== cur.status)
    await store.logEvent(ctx, "job.tracking_status", "job", jobId, { from: cur.status, to: next.status });
  return next;
}
