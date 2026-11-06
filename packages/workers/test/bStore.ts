// Minimal local fake implementing only the Store methods Agent B calls. Replace with @ros/db InMemoryStore when it lands.
import { randomUUID } from "node:crypto";
import { Preferences, type Ctx, type JobRow, type IngestionRow, type ApplicationRow, type ExceptionRow, type EventRecord, type ResumeVersionRow, type Store, type IngestRequest } from "@ros/core";

export function makeFakeStore() {
  const jobs = new Map<string, JobRow>(), ings = new Map<string, IngestionRow>(), apps = new Map<string, ApplicationRow>();
  const exceptions: ExceptionRow[] = [], events: EventRecord[] = [], resumes: ResumeVersionRow[] = [], actions: any[] = [];
  let prefs = Preferences.parse({});
  const store: Partial<Store> = {
    async getPreferences() { return prefs; },
    async setPreferences(_c, p) { prefs = Preferences.parse({ ...prefs, ...p }); return prefs; },
    async createIngestion(ctx, request: IngestRequest) {
      const r: IngestionRow = { id: randomUUID(), ctx, request, status: "accepted", jobId: null, error: null, attempts: 0, createdAt: new Date().toISOString() };
      ings.set(r.id, r); return r;
    },
    async getIngestion(_c, id) { return ings.get(id) ?? null; },
    async updateIngestion(_c, id, patch) { Object.assign(ings.get(id)!, patch); },
    async upsertJob(ctx, ingestionId, normalized) {
      const dup = [...jobs.values()].find((j) => j.normalized.dedupeKey === normalized.dedupeKey && j.ctx.tenantId === ctx.tenantId);
      if (dup) return { job: dup, duplicate: true };
      const now = new Date().toISOString();
      const job: JobRow = { id: randomUUID(), ctx, stage: "ingested", normalized, score: null, ingestionId, duplicateOf: null, createdAt: now, updatedAt: now };
      jobs.set(job.id, job); return { job, duplicate: false };
    },
    async setJobStage(_c, id, stage, score) { const j = jobs.get(id)!; j.stage = stage; if (score) j.score = score; },
    async getJob(_c, id) { return jobs.get(id) ?? null; },
    async getOrCreateApplication(ctx, jobId) {
      const ex = [...apps.values()].find((a) => a.jobId === jobId);
      if (ex) return { app: ex, created: false };
      const app: ApplicationRow = { id: randomUUID(), ctx, jobId, idempotencyKey: `app:${jobId}`, status: "pending", confirmed: false, resumeVersionId: null, coverLetterId: null, evidence: null, submittedAt: null, attempts: 0, lastError: null };
      apps.set(app.id, app); return { app, created: true };
    },
    async updateApplication(_c, id, patch) { Object.assign(apps.get(id)!, patch); },
    async getApplicationByJob(_c, jobId) { return [...apps.values()].find((a) => a.jobId === jobId) ?? null; },
    async saveResumeVersion(ctx, row) { const r = { ...row, id: randomUUID(), createdAt: new Date().toISOString() } as ResumeVersionRow; resumes.push(r); return r; },
    async raiseException(ctx, e) { const r: ExceptionRow = { ...e, id: randomUUID(), createdAt: new Date().toISOString(), resolvedAt: null }; exceptions.push(r); return r; },
    async logEvent(ctx, kind, entityType, entityId, payload = {}) { events.push({ id: randomUUID(), tenantId: ctx.tenantId, userId: ctx.userId, kind, entityType, entityId, payload, createdAt: new Date().toISOString() }); },
    async recordExternalAction(_c, a) { actions.push(a); },
  };
  return { store: store as Store, jobs, ings, apps, exceptions, events, resumes, actions };
}
export const ctx: Ctx = { tenantId: "t1", userId: "u1" };
