// SHARED PERSISTENCE CONTRACT. Owner: lead; implementations: Agent A (Supabase) + InMemoryStore (tests).
// Workers/MCP/web depend ONLY on this interface, so work proceeds in parallel before the DB is live.
import type {
  EventRecord, ExceptionType, ExternalActionStatus, IngestRequest, JobStage, NormalizedJob,
  Preferences, ScoreBreakdown, ResumeArchetype,
} from "./domain.js";

export interface Ctx { tenantId: string; userId: string }

export interface JobRow {
  id: string; ctx: Ctx; stage: JobStage; normalized: NormalizedJob; score: ScoreBreakdown | null;
  ingestionId: string; duplicateOf: string | null; createdAt: string; updatedAt: string;
}
export interface IngestionRow {
  id: string; ctx: Ctx; request: IngestRequest; status: "accepted" | "processing" | "done" | "failed" | "dead_letter";
  jobId: string | null; error: string | null; attempts: number; createdAt: string;
}
export interface ApplicationRow {
  id: string; ctx: Ctx; jobId: string; idempotencyKey: string; status: ExternalActionStatus | "pending";
  confirmed: boolean; resumeVersionId: string | null; coverLetterId: string | null;
  evidence: unknown; submittedAt: string | null; attempts: number; lastError: string | null;
}
export interface ExceptionRow {
  id: string; ctx: Ctx; type: ExceptionType; entityType: string; entityId: string | null;
  detail: string; resolvedAt: string | null; createdAt: string;
}
export interface ResumeVersionRow {
  id: string; ctx: Ctx; jobId: string; archetype: ResumeArchetype; evidenceIds: string[];
  relevanceScore: number; factualConfidence: number; storagePath: string | null; contentJson: unknown; createdAt: string;
}
export interface CompanyRow { id: string; ctx: Ctx; name: string; domain: string | null; research: unknown | null; researchedAt: string | null }
export interface ContactRow {
  id: string; ctx: Ctx; companyId: string; name: string; title: string | null; email: string | null;
  linkedinUrl: string | null; relevance: number; source: string; suppressed: boolean; suppressReason: string | null;
}
export interface OutreachRow {
  id: string; ctx: Ctx; contactId: string; jobId: string | null; step: number; channel: "email";
  status: "draft" | "scheduled" | "sent" | "dry_run" | "failed" | "stopped"; subject: string; body: string;
  scheduledFor: string | null; sentAt: string | null; threadId: string | null; stopReason: string | null;
}

export interface Store {
  // tenancy
  getPreferences(ctx: Ctx): Promise<Preferences>;
  setPreferences(ctx: Ctx, patch: Partial<Preferences>): Promise<Preferences>;
  // ingestion
  createIngestion(ctx: Ctx, req: IngestRequest): Promise<IngestionRow>; // idempotent on req.idempotencyKey
  getIngestion(ctx: Ctx, id: string): Promise<IngestionRow | null>;
  updateIngestion(ctx: Ctx, id: string, patch: Partial<Pick<IngestionRow, "status" | "jobId" | "error" | "attempts">>): Promise<void>;
  claimIngestions(limit: number): Promise<IngestionRow[]>;             // worker: accepted -> processing
  // jobs
  upsertJob(ctx: Ctx, ingestionId: string, normalized: NormalizedJob): Promise<{ job: JobRow; duplicate: boolean }>;
  setJobStage(ctx: Ctx, jobId: string, stage: JobStage, score?: ScoreBreakdown): Promise<void>;
  getJob(ctx: Ctx, id: string): Promise<JobRow | null>;
  searchJobs(ctx: Ctx, q: { text?: string; stage?: JobStage; minScore?: number; limit?: number }): Promise<JobRow[]>;
  pipelineCounts(ctx: Ctx): Promise<Record<JobStage, number>>;
  // applications (idempotent on (tenant, job) via idempotencyKey)
  getOrCreateApplication(ctx: Ctx, jobId: string): Promise<{ app: ApplicationRow; created: boolean }>;
  updateApplication(ctx: Ctx, id: string, patch: Partial<ApplicationRow>): Promise<void>;
  getApplicationByJob(ctx: Ctx, jobId: string): Promise<ApplicationRow | null>;
  saveResumeVersion(ctx: Ctx, row: Omit<ResumeVersionRow, "id" | "createdAt">): Promise<ResumeVersionRow>;
  // exceptions
  raiseException(ctx: Ctx, e: Omit<ExceptionRow, "id" | "createdAt" | "resolvedAt">): Promise<ExceptionRow>;
  listExceptions(ctx: Ctx, openOnly?: boolean): Promise<ExceptionRow[]>;
  resolveException(ctx: Ctx, id: string): Promise<boolean>; // false when not found in this tenant
  // company / contacts / outreach
  upsertCompany(ctx: Ctx, name: string, domain: string | null): Promise<CompanyRow>;
  saveCompanyResearch(ctx: Ctx, companyId: string, research: unknown): Promise<void>;
  getCompanyByName(ctx: Ctx, name: string): Promise<CompanyRow | null>;
  upsertContact(ctx: Ctx, c: Omit<ContactRow, "id" | "suppressed" | "suppressReason">): Promise<ContactRow>;
  listContacts(ctx: Ctx, companyId: string): Promise<ContactRow[]>;
  suppressContact(ctx: Ctx, contactId: string, reason: string): Promise<void>; // also stops pending outreach
  createOutreach(ctx: Ctx, o: Omit<OutreachRow, "id" | "sentAt" | "stopReason" | "threadId">): Promise<OutreachRow>;
  updateOutreach(ctx: Ctx, id: string, patch: Partial<OutreachRow>): Promise<void>;
  listOutreach(ctx: Ctx, q: { jobId?: string; contactId?: string; dueBefore?: string }): Promise<OutreachRow[]>;
  // event log + dead letter + external actions
  logEvent(ctx: Ctx, kind: string, entityType: string, entityId: string | null, payload?: Record<string, unknown>): Promise<void>;
  listEvents(ctx: Ctx, q: { entityId?: string; kind?: string; limit?: number }): Promise<EventRecord[]>;
  recordExternalAction(ctx: Ctx, a: { system: string; action: string; status: ExternalActionStatus; entityId?: string; detail?: string }): Promise<void>;
}
