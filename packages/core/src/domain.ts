// SHARED DOMAIN CONTRACT. Owner: lead. Changes require a DECISIONS.md entry.
// Every agent codes against these types; the DB schema (Agent A) must mirror them.
import { z } from "zod";

export const ExternalActionStatus = z.enum(["succeeded", "failed", "unverified", "dry_run"]);
export type ExternalActionStatus = z.infer<typeof ExternalActionStatus>;

export const JobStage = z.enum([
  "ingested",      // accepted, raw payload stored
  "normalized",    // fields extracted
  "duplicate",     // matched an existing job (terminal)
  "researched",
  "scored",
  "archived",      // below threshold or ineligible (terminal, reversible)
  "qualified",     // above threshold, awaiting application
  "applying",
  "applied",       // submission CONFIRMED (never set without confirmation evidence)
  "needs_human",   // exception queue
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
]);
export type JobStage = z.infer<typeof JobStage>;

export const IngestSource = z.enum([
  "manual_url", "manual_text", "mcp", "gmail_alert", "whatsapp_export", "gdrive_sheet",
  "handshake", "twelve_twenty", "linkedin_alert", "ats_feed", "career_page", "x_lead", "spreadsheet_upload",
]);
export type IngestSource = z.infer<typeof IngestSource>;

export const RoleCategory = z.enum([
  "product_management", "product_marketing", "gtm_strategy", "founders_office",
  "bizops_corp_strategy", "growth_brand", "ai_strategy", "strategic_partnerships", "vc_pe_search", "other",
]);
export type RoleCategory = z.infer<typeof RoleCategory>;

export const ResumeArchetype = z.enum(["product_management", "product_marketing", "gtm_strategy", "founders_office_bizops"]);
export type ResumeArchetype = z.infer<typeof ResumeArchetype>;

export const AtsKind = z.enum(["greenhouse", "lever", "ashby", "workday", "icims", "smartrecruiters", "other", "unknown"]);
export type AtsKind = z.infer<typeof AtsKind>;

// ---- Ingestion ----
export const IngestRequest = z.object({
  source: IngestSource.default("manual_url"),
  url: z.string().url().optional(),
  text: z.string().min(1).optional(),
  fileRef: z.string().optional(),            // Supabase Storage path
  job: z.lazy(() => StructuredJobInput).optional(),
  idempotencyKey: z.string().max(200).optional(),
  note: z.string().max(2000).optional(),
}).refine((v) => v.url || v.text || v.fileRef || v.job, { message: "one of url|text|fileRef|job is required" });
export type IngestRequest = z.infer<typeof IngestRequest>;

export const StructuredJobInput = z.object({
  title: z.string(),
  company: z.string(),
  location: z.string().optional(),
  description: z.string().optional(),
  applyUrl: z.string().url().optional(),
  sourceUrl: z.string().url().optional(),
  salaryMin: z.number().optional(),
  salaryMax: z.number().optional(),
  salaryCurrency: z.string().optional(),
  deadline: z.string().optional(),           // ISO date
  postedAt: z.string().optional(),
});
export type StructuredJobInput = z.infer<typeof StructuredJobInput>;

export const IngestResponse = z.object({
  ingestionId: z.string().uuid(),
  status: z.literal("accepted"),
  duplicateOf: z.string().uuid().nullable().default(null),
});
export type IngestResponse = z.infer<typeof IngestResponse>;

// ---- Normalized job ----
export const NormalizedJob = z.object({
  title: z.string(),
  company: z.string(),
  companyDomain: z.string().nullable().default(null),
  location: z.string().nullable().default(null),
  remote: z.boolean().nullable().default(null),
  description: z.string().default(""),
  applyUrl: z.string().url().nullable().default(null),
  sourceUrl: z.string().url().nullable().default(null),
  atsKind: AtsKind.default("unknown"),
  atsJobId: z.string().nullable().default(null),
  salaryMin: z.number().nullable().default(null),
  salaryMax: z.number().nullable().default(null),
  salaryCurrency: z.string().nullable().default(null),
  deadline: z.string().nullable().default(null),
  roleCategory: RoleCategory.default("other"),
  isInternship: z.boolean().nullable().default(null),
  eligibility: z.object({
    mbaRequired: z.boolean().nullable().default(null),
    workAuthNotes: z.string().nullable().default(null),
    summer2027: z.boolean().nullable().default(null),
  }).default({}),
  dedupeKey: z.string(),                      // sha256(norm(company)|norm(title)|norm(location)) or ATS id
});
export type NormalizedJob = z.infer<typeof NormalizedJob>;

// ---- Scoring ----
export const ScoreBreakdown = z.object({
  total: z.number().min(0).max(100),
  roleFit: z.number(), comp: z.number(), conversion: z.number(), responsibility: z.number(),
  flexibility: z.number(), upside: z.number(), entrepreneurialCompat: z.number(),
  hardRejects: z.array(z.string()).default([]),
  rationale: z.string(),
  decision: z.enum(["qualify", "archive", "needs_review"]),
});
export type ScoreBreakdown = z.infer<typeof ScoreBreakdown>;

// ---- Preferences / automation policy ----
export const AutomationPolicy = z.object({
  mode: z.enum(["dry_run", "live"]).default("dry_run"),     // DEFAULT dry_run until verified
  autoApply: z.boolean().default(false),
  autoOutreach: z.boolean().default(false),
  minScoreToApply: z.number().default(65),
  minScoreForProofOfWork: z.number().default(80),
  maxApplicationsPerDay: z.number().default(15),
  maxOutreachPerDay: z.number().default(20),
  followUpDays: z.array(z.number()).default([4, 9, 16]),
  quietHours: z.object({ startHour: z.number().default(21), endHour: z.number().default(7), tz: z.string().default("America/New_York") }).default({}),
});
export type AutomationPolicy = z.infer<typeof AutomationPolicy>;

export const Preferences = z.object({
  targetSeason: z.string().default("Summer 2027"),
  roleOrder: z.array(RoleCategory).default([
    "product_management", "product_marketing", "gtm_strategy", "founders_office", "bizops_corp_strategy",
    "growth_brand", "ai_strategy", "strategic_partnerships", "vc_pe_search",
  ]),
  minHourlyUsd: z.number().nullable().default(null),
  locationsPreferred: z.array(z.string()).default([]),
  locationsExcluded: z.array(z.string()).default([]),
  excludedCompanies: z.array(z.string()).default([]),
  weights: z.object({
    roleFit: z.number().default(0.35), comp: z.number().default(0.15), conversion: z.number().default(0.15),
    responsibility: z.number().default(0.15), flexibility: z.number().default(0.05),
    upside: z.number().default(0.1), entrepreneurialCompat: z.number().default(0.05),
  }).default({}),
  policy: AutomationPolicy.default({}),
});
export type Preferences = z.infer<typeof Preferences>;

// ---- Event log + exceptions ----
export const EventKind = z.string(); // dotted names, e.g. "job.ingested", "application.submitted"
export interface EventRecord {
  id: string; tenantId: string; userId: string; kind: string; entityType: string; entityId: string | null;
  payload: Record<string, unknown>; createdAt: string;
}

export const ExceptionType = z.enum([
  "captcha", "auth_required", "sensitive_eligibility_question", "platform_restricts_automation",
  "missing_profile_field", "low_factual_confidence", "submission_unverified", "integration_not_connected", "other",
]);
export type ExceptionType = z.infer<typeof ExceptionType>;

// ---- Application ----
export const ApplicationAttemptResult = z.object({
  status: ExternalActionStatus,
  confirmed: z.boolean(),                       // true ONLY with confirmation evidence
  confirmationEvidence: z.object({
    kind: z.enum(["confirmation_page_text", "confirmation_email", "api_response", "screenshot"]),
    detail: z.string(), url: z.string().optional(),
  }).nullable().default(null),
  exception: z.object({ type: ExceptionType, detail: z.string() }).nullable().default(null),
});
export type ApplicationAttemptResult = z.infer<typeof ApplicationAttemptResult>;

// ---- Resume ----
export const EvidenceItem = z.object({
  id: z.string(),                     // stable slug, e.g. "lm-cicd-7-teams"
  employer: z.string(), role: z.string(), dates: z.string(),
  statement: z.string(),              // verified bullet, verbatim from user's documents
  metrics: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  verifiedBy: z.enum(["resume", "supporting_doc", "user_confirmed"]),
  sourceDoc: z.string(),
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;
