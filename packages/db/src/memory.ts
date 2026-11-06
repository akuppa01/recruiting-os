import { randomUUID } from "node:crypto";
import {
  Preferences, JobStage,
  type Ctx, type Store, type JobRow, type IngestionRow, type ApplicationRow, type ExceptionRow,
  type ResumeVersionRow, type CompanyRow, type ContactRow, type OutreachRow, type EventRecord,
  type IngestRequest, type NormalizedJob, type ScoreBreakdown, type ExternalActionStatus,
} from "@ros/core";

const now = () => new Date().toISOString();
const same = (a: Ctx, b: Ctx) => a.tenantId === b.tenantId && a.userId === b.userId;
const key = (c: Ctx) => `${c.tenantId}:${c.userId}`;

export interface ExternalActionRow {
  id: string; ctx: Ctx; system: string; action: string; status: ExternalActionStatus;
  entityId: string | null; detail: string | null; createdAt: string;
}

/** Process-local Store used for tests and demo mode. Mirrors SupabaseStore semantics. */
export class InMemoryStore implements Store {
  prefs = new Map<string, Preferences>();
  ingestions = new Map<string, IngestionRow>();
  jobs = new Map<string, JobRow>();
  applications = new Map<string, ApplicationRow>();
  resumes = new Map<string, ResumeVersionRow>();
  exceptions = new Map<string, ExceptionRow>();
  companies = new Map<string, CompanyRow>();
  contacts = new Map<string, ContactRow>();
  outreach = new Map<string, OutreachRow>();
  events: EventRecord[] = [];
  externalActions: ExternalActionRow[] = [];

  async getPreferences(ctx: Ctx) { return this.prefs.get(key(ctx)) ?? Preferences.parse({}); }
  async setPreferences(ctx: Ctx, patch: Partial<Preferences>) {
    const cur = await this.getPreferences(ctx);
    const next = Preferences.parse({ ...cur, ...patch });
    this.prefs.set(key(ctx), next);
    return next;
  }

  async createIngestion(ctx: Ctx, req: IngestRequest) {
    if (req.idempotencyKey) {
      for (const i of this.ingestions.values())
        if (same(i.ctx, ctx) && i.request.idempotencyKey === req.idempotencyKey) return i;
    }
    const row: IngestionRow = { id: randomUUID(), ctx, request: req, status: "accepted", jobId: null, error: null, attempts: 0, createdAt: now() };
    this.ingestions.set(row.id, row);
    return row;
  }
  async getIngestion(ctx: Ctx, id: string) {
    const r = this.ingestions.get(id);
    return r && same(r.ctx, ctx) ? r : null;
  }
  async updateIngestion(ctx: Ctx, id: string, patch: Partial<Pick<IngestionRow, "status" | "jobId" | "error" | "attempts">>) {
    const r = await this.getIngestion(ctx, id);
    if (r) Object.assign(r, patch);
  }
  async claimIngestions(limit: number) {
    const out: IngestionRow[] = [];
    for (const i of this.ingestions.values()) {
      if (out.length >= limit) break;
      if (i.status === "accepted") { i.status = "processing"; out.push(i); }
    }
    return out;
  }

  async upsertJob(ctx: Ctx, ingestionId: string, normalized: NormalizedJob) {
    for (const j of this.jobs.values())
      if (same(j.ctx, ctx) && j.ingestionId === ingestionId) return { job: j, duplicate: j.stage === "duplicate" };
    let original: JobRow | undefined;
    for (const j of this.jobs.values())
      if (same(j.ctx, ctx) && j.stage !== "duplicate" && j.normalized.dedupeKey === normalized.dedupeKey) { original = j; break; }
    const t = now();
    const job: JobRow = {
      id: randomUUID(), ctx, stage: original ? "duplicate" : "normalized", normalized, score: null,
      ingestionId, duplicateOf: original?.id ?? null, createdAt: t, updatedAt: t,
    };
    this.jobs.set(job.id, job);
    return { job, duplicate: !!original };
  }
  async setJobStage(ctx: Ctx, jobId: string, stage: JobStage, score?: ScoreBreakdown) {
    const j = await this.getJob(ctx, jobId);
    if (!j) return;
    j.stage = stage; if (score) j.score = score; j.updatedAt = now();
  }
  async getJob(ctx: Ctx, id: string) {
    const j = this.jobs.get(id);
    return j && same(j.ctx, ctx) ? j : null;
  }
  async searchJobs(ctx: Ctx, q: { text?: string; stage?: JobStage; minScore?: number; limit?: number }) {
    const t = q.text?.toLowerCase();
    return [...this.jobs.values()]
      .filter((j) => same(j.ctx, ctx))
      .filter((j) => !q.stage || j.stage === q.stage)
      .filter((j) => q.minScore == null || (j.score?.total ?? -1) >= q.minScore)
      .filter((j) => !t || `${j.normalized.title} ${j.normalized.company} ${j.normalized.description}`.toLowerCase().includes(t))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, q.limit ?? 50);
  }
  async pipelineCounts(ctx: Ctx) {
    const out = Object.fromEntries(JobStage.options.map((s) => [s, 0])) as Record<JobStage, number>;
    for (const j of this.jobs.values()) if (same(j.ctx, ctx)) out[j.stage]++;
    return out;
  }

  async getOrCreateApplication(ctx: Ctx, jobId: string) {
    // no await between check and insert => atomic in the single-threaded event loop
    for (const a of this.applications.values()) if (same(a.ctx, ctx) && a.jobId === jobId) return { app: a, created: false };
    const app: ApplicationRow = {
      id: randomUUID(), ctx, jobId, idempotencyKey: `${ctx.tenantId}:${jobId}`, status: "pending", confirmed: false,
      resumeVersionId: null, coverLetterId: null, evidence: null, submittedAt: null, attempts: 0, lastError: null,
    };
    this.applications.set(app.id, app);
    return { app, created: true };
  }
  async updateApplication(ctx: Ctx, id: string, patch: Partial<ApplicationRow>) {
    const a = this.applications.get(id);
    if (a && same(a.ctx, ctx)) {
      // never allow a confirmed flag without evidence
      if (patch.confirmed && !(patch.evidence ?? a.evidence)) throw new Error("confirmed=true requires evidence");
      const { id: _i, ctx: _c, ...rest } = patch; Object.assign(a, rest);
    }
  }
  async getApplicationByJob(ctx: Ctx, jobId: string) {
    for (const a of this.applications.values()) if (same(a.ctx, ctx) && a.jobId === jobId) return a;
    return null;
  }
  async saveResumeVersion(ctx: Ctx, row: Omit<ResumeVersionRow, "id" | "createdAt">) {
    const r: ResumeVersionRow = { ...row, ctx, id: randomUUID(), createdAt: now() };
    this.resumes.set(r.id, r);
    return r;
  }

  async raiseException(ctx: Ctx, e: Omit<ExceptionRow, "id" | "createdAt" | "resolvedAt">) {
    const r: ExceptionRow = { ...e, ctx, id: randomUUID(), createdAt: now(), resolvedAt: null };
    this.exceptions.set(r.id, r);
    return r;
  }
  async listExceptions(ctx: Ctx, openOnly = false) {
    return [...this.exceptions.values()].filter((e) => same(e.ctx, ctx) && (!openOnly || !e.resolvedAt));
  }

  async upsertCompany(ctx: Ctx, name: string, domain: string | null) {
    const n = name.trim().toLowerCase();
    for (const c of this.companies.values())
      if (same(c.ctx, ctx) && (c.name.toLowerCase() === n || (domain && c.domain === domain))) {
        if (domain && !c.domain) c.domain = domain;
        return c;
      }
    const c: CompanyRow = { id: randomUUID(), ctx, name: name.trim(), domain, research: null, researchedAt: null };
    this.companies.set(c.id, c);
    return c;
  }
  async saveCompanyResearch(ctx: Ctx, companyId: string, research: unknown) {
    const c = this.companies.get(companyId);
    if (c && same(c.ctx, ctx)) { c.research = research; c.researchedAt = now(); }
  }
  async getCompanyByName(ctx: Ctx, name: string) {
    const n = name.trim().toLowerCase();
    for (const c of this.companies.values()) if (same(c.ctx, ctx) && c.name.toLowerCase() === n) return c;
    return null;
  }
  async upsertContact(ctx: Ctx, c: Omit<ContactRow, "id" | "suppressed" | "suppressReason">) {
    for (const x of this.contacts.values())
      if (same(x.ctx, ctx) && x.companyId === c.companyId &&
        ((c.email && x.email === c.email) || (c.linkedinUrl && x.linkedinUrl === c.linkedinUrl) || x.name === c.name)) {
        Object.assign(x, { ...c, ctx });
        return x;
      }
    const row: ContactRow = { ...c, ctx, id: randomUUID(), suppressed: false, suppressReason: null };
    this.contacts.set(row.id, row);
    return row;
  }
  async listContacts(ctx: Ctx, companyId: string) {
    return [...this.contacts.values()].filter((c) => same(c.ctx, ctx) && c.companyId === companyId).sort((a, b) => b.relevance - a.relevance);
  }
  async suppressContact(ctx: Ctx, contactId: string, reason: string) {
    const c = this.contacts.get(contactId);
    if (!c || !same(c.ctx, ctx)) return;
    c.suppressed = true; c.suppressReason = reason;
    for (const o of this.outreach.values())
      if (same(o.ctx, ctx) && o.contactId === contactId && (o.status === "draft" || o.status === "scheduled")) {
        o.status = "stopped"; o.stopReason = reason;
      }
  }
  async createOutreach(ctx: Ctx, o: Omit<OutreachRow, "id" | "sentAt" | "stopReason" | "threadId">) {
    const row: OutreachRow = { ...o, ctx, id: randomUUID(), sentAt: null, stopReason: null, threadId: null };
    this.outreach.set(row.id, row);
    return row;
  }
  async updateOutreach(ctx: Ctx, id: string, patch: Partial<OutreachRow>) {
    const o = this.outreach.get(id);
    if (o && same(o.ctx, ctx)) { const { id: _i, ...rest } = patch; Object.assign(o, rest); }
  }
  async listOutreach(ctx: Ctx, q: { jobId?: string; contactId?: string; dueBefore?: string }) {
    return [...this.outreach.values()]
      .filter((o) => same(o.ctx, ctx))
      .filter((o) => !q.jobId || o.jobId === q.jobId)
      .filter((o) => !q.contactId || o.contactId === q.contactId)
      .filter((o) => !q.dueBefore || (o.scheduledFor != null && o.scheduledFor <= q.dueBefore));
  }

  async logEvent(ctx: Ctx, kind: string, entityType: string, entityId: string | null, payload: Record<string, unknown> = {}) {
    this.events.push({ id: randomUUID(), tenantId: ctx.tenantId, userId: ctx.userId, kind, entityType, entityId, payload, createdAt: now() });
  }
  async listEvents(ctx: Ctx, q: { entityId?: string; kind?: string; limit?: number }) {
    return this.events
      .filter((e) => e.tenantId === ctx.tenantId && e.userId === ctx.userId)
      .filter((e) => !q.entityId || e.entityId === q.entityId)
      .filter((e) => !q.kind || e.kind === q.kind)
      .slice(-(q.limit ?? 100));
  }
  async recordExternalAction(ctx: Ctx, a: { system: string; action: string; status: ExternalActionStatus; entityId?: string; detail?: string }) {
    this.externalActions.push({ id: randomUUID(), ctx, system: a.system, action: a.action, status: a.status, entityId: a.entityId ?? null, detail: a.detail ?? null, createdAt: now() });
  }
}
