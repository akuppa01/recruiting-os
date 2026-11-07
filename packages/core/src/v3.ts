// V3 SHARED CONTRACTS. Owner: lead. Every workstream codes against these; change only via the lead.
// Tables behind these types are defined in supabase/migrations/0005_v3_pipeline.sql.
import { z } from "zod";
import type { Ctx } from "./store.js";
import type { AtsKind, StructuredJobInput } from "./domain.js";

// ------------------------------------------------------------------ discovery
export const SourceId = z.enum([
  "handshake", "twelve_twenty", "linkedin_alert", "indeed_alert",
  "greenhouse", "lever", "ashby", "remote_feed", "manual", "csv", "whatsapp",
]);
export type SourceId = z.infer<typeof SourceId>;

export type SourceStatus = "ok" | "degraded" | "failed" | "not_configured";
export interface SourceHealth {
  source: SourceId; status: SourceStatus;
  lastAttemptAt: string | null; lastSuccessAt: string | null; lastError: string | null;
  itemsLastRun: number; itemsTotal: number;
}

/** One job as found by a source, with the evidence needed to audit where it came from. */
export interface DiscoveredJob {
  source: SourceId;
  sourceRef: string;                       // email message id, feed board+id, file row, etc.
  canonicalUrl: string | null;             // resolved application/posting URL (tracking params stripped)
  job: StructuredJobInput;
  evidence: { kind: "email" | "feed" | "import" | "manual"; excerpt?: string; receivedAt?: string; board?: string };
  /** School-specific eligibility/application text from Handshake/12twenty, preserved verbatim. */
  schoolRequirements?: string;
  /** True when only a URL was found (title/company are placeholders); ingest should enrich from the posting. */
  needsEnrichment?: boolean;
}

export interface SourceRunResult { source: SourceId; jobs: DiscoveredJob[]; error?: string; notConfigured?: string }

export interface SourceAdapter {
  id: SourceId;
  kind: "feed" | "email" | "import";
  /** Never throws for expected conditions: returns notConfigured/error so health can be recorded honestly. */
  run(ctx: Ctx, opts?: { since?: string; limit?: number }): Promise<SourceRunResult>;
}

export interface SourceHealthStore {
  record(ctx: Ctx, r: SourceRunResult): Promise<void>;            // ok / degraded / failed / not_configured + counts + timestamps
  list(ctx: Ctx): Promise<SourceHealth[]>;
}

// ------------------------------------------------------------------ durable task queue
export const TaskKind = z.enum(["discover", "ingest", "qualify", "tailor", "apply", "verify", "outreach"]);
export type TaskKind = z.infer<typeof TaskKind>;
export type TaskStatus = "queued" | "leased" | "done" | "failed" | "dead";

export interface Task {
  id: string; ctx: Ctx; kind: TaskKind; payload: Record<string, unknown>; status: TaskStatus;
  idempotencyKey: string; priority: number; attempts: number; maxAttempts: number;
  runAfter: string; leaseUntil: string | null; workerId: string | null; lastError: string | null;
  result: Record<string, unknown> | null; costUsd: number; createdAt: string;
}

export interface EnqueueInput {
  kind: TaskKind; payload?: Record<string, unknown>; idempotencyKey: string;
  priority?: number; runAfter?: string; maxAttempts?: number;
}

export interface TaskQueue {
  /** Idempotent on (tenant, user, idempotencyKey): a second call returns the existing task, never a duplicate. */
  enqueue(ctx: Ctx, t: EnqueueInput): Promise<{ task: Task; created: boolean }>;
  /** Atomically leases up to `limit` ready tasks (queued, or leased with an expired lease). Never double-leases. */
  lease(workerId: string, kinds: TaskKind[], opts?: { limit?: number; leaseSeconds?: number }): Promise<Task[]>;
  heartbeat(taskId: string, workerId: string, extendSeconds?: number): Promise<boolean>;     // false = lease lost
  complete(taskId: string, workerId: string, o?: { result?: Record<string, unknown>; costUsd?: number }): Promise<void>;
  /** retry=true re-queues with backoff until maxAttempts, then marks 'dead' (dead-letter). */
  fail(taskId: string, workerId: string, error: string, o?: { retry?: boolean; backoffSeconds?: number; costUsd?: number }): Promise<Task>;
  /** Crash recovery: leased tasks whose lease expired go back to 'queued' (or 'dead' past maxAttempts). Returns count. */
  reapExpired(): Promise<number>;
  log(taskId: string, level: "debug" | "info" | "warn" | "error", message: string, data?: Record<string, unknown>): Promise<void>;
  get(ctx: Ctx, id: string): Promise<Task | null>;
  list(ctx: Ctx, q?: { kind?: TaskKind; status?: TaskStatus; limit?: number }): Promise<Task[]>;
  deadLetters(ctx: Ctx, limit?: number): Promise<Task[]>;
  workerHeartbeat(workerId: string, info: { host?: string; kinds: TaskKind[]; currentTask?: string | null }): Promise<void>;
}

/** A task handler does the work for one kind. Throwing marks the attempt failed; return value is stored as the result. */
export interface TaskHandlerHelpers {
  log(level: "debug" | "info" | "warn" | "error", message: string, data?: Record<string, unknown>): Promise<void>;
  addCost(usd: number): void;
}
export type TaskHandler = (task: Task, h: TaskHandlerHelpers) => Promise<Record<string, unknown> | void>;

// ------------------------------------------------------------------ ATS form memory + executor strategies
export type ExecutionStrategy = "deterministic" | "stagehand" | "agent";

export interface FormFieldMapping {
  label: string; selector: string; kind: "text" | "textarea" | "select" | "combobox" | "radio" | "checkbox" | "file";
  mapsTo: string;                            // e.g. "first_name", "resume", "answer:work_authorization", "unknown"
}
export interface FormTemplate {
  provider: AtsKind; signature: string; version: number;
  fieldMap: FormFieldMapping[];
  uploadBehavior: { resumeSelector?: string; viaButton?: boolean };
  validationRules: Record<string, unknown>;
  confirmationSignals: { urlPatterns: string[]; textPatterns: string[] };
  successCount: number; failureCount: number; lastSuccessAt: string | null; lastFailureAt: string | null;
}
/** Shared across users: stores selectors/labels only, NEVER applicant answers. */
export interface FormTemplateStore {
  get(provider: AtsKind, signature: string): Promise<FormTemplate | null>;
  recordSuccess(t: Pick<FormTemplate, "provider" | "signature"> & Partial<FormTemplate>): Promise<void>;
  recordFailure(provider: AtsKind, signature: string): Promise<void>;
}

export interface ApplyAttempt {
  strategy: ExecutionStrategy;
  outcome: "submitted_confirmed" | "submitted_unverified" | "blocked" | "dry_run" | "unsupported" | "failed";
  seconds: number; modelCalls: number; costUsd: number;
  fieldsFilled: number; fieldsExpected: number;
  exception?: { type: string; detail: string };
}

export interface PipelineLimits {
  dailyAiUsd: number; monthlyAiUsd: number; perApplicationAiUsd: number;
  maxFallbackAttempts: number; maxBrowserSeconds: number;
}
export const DEFAULT_LIMITS: PipelineLimits = { dailyAiUsd: 2, monthlyAiUsd: 30, perApplicationAiUsd: 0.15, maxFallbackAttempts: 2, maxBrowserSeconds: 300 };
