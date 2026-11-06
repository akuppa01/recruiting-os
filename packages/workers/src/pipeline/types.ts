import type { ApplicationAttemptResult, Ctx, IngestRequest, IngestResponse, JobRow, NormalizedJob, Store } from "@ros/core";
import type { Notifier } from "../notify/index.js";

/** Stage function: mutates store itself (AGENTS.md signature). */
export type StageFn = (store: Store, ctx: Ctx, jobId: string) => Promise<void>;
export type ApplyFn = (store: Store, ctx: Ctx, job: JobRow, o: { mode: "dry_run" | "live"; applicationId: string; resumeVersionId: string | null }) => Promise<ApplicationAttemptResult>;

/** Dependency-injected stage registry. Missing optional stages are recorded as skipped (never silently "succeeded"). */
export interface PipelineStages {
  normalize: (req: IngestRequest) => Promise<NormalizedJob>;   // B
  research?: StageFn;      // C: company+role research, sets company research
  score: StageFn;          // B: must call store.setJobStage(ctx, jobId, "scored", breakdown)
  resume?: StageFn;        // B: saveResumeVersion
  coverLetter?: StageFn;   // B
  apply?: ApplyFn;         // B: adapter (dry-run capable). Orchestrator owns status/confirmation rules.
  contacts?: StageFn;      // C
  proofOfWork?: StageFn;   // C
  outreach?: StageFn;      // C: drafts/sends per policy, schedules follow-ups
  followups?: StageFn;     // C
}

export interface PipelineOpts {
  notifier?: Notifier;
  maxAttempts?: number;                 // per stage, default 3
  baseDelayMs?: number;                 // backoff base, default 500
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export type PipelineOutcome =
  | { status: "done"; jobId: string; stage: string }
  | { status: "duplicate"; jobId: string; duplicateOf: string }
  | { status: "dead_letter"; jobId: string | null; failedStage: string; error: string }
  | { status: "skipped"; reason: string };

export type { IngestResponse };
