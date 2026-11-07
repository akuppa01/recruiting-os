import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  Preferences, JobStage,
  type Ctx, type Store, type JobRow, type IngestionRow, type ApplicationRow, type ExceptionRow,
  type ResumeVersionRow, type CompanyRow, type ContactRow, type OutreachRow, type EventRecord,
  type IngestRequest, type NormalizedJob, type ScoreBreakdown, type ExternalActionStatus,
} from "@ros/core";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const UNIQUE_VIOLATION = "23505";

function fail(op: string, error: { message: string; code?: string } | null): never {
  throw new Error(`SupabaseStore.${op}: ${error?.message ?? "unknown error"}`);
}

export function createServiceClient(url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY): SupabaseClient {
  if (!url || !key) throw new Error("Supabase URL / service role key not configured");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export const hasSupabaseEnv = () => !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

const ctxOf = (r: Row): Ctx => ({ tenantId: r.tenant_id, userId: r.user_id });
const scope = (ctx: Ctx) => ({ tenant_id: ctx.tenantId, user_id: ctx.userId });

const toIngestion = (r: Row): IngestionRow => ({
  id: r.id, ctx: ctxOf(r), request: r.request, status: r.status, jobId: r.job_id, error: r.error, attempts: r.attempts, createdAt: r.created_at,
});
const toJob = (r: Row): JobRow => ({
  id: r.id, ctx: ctxOf(r), stage: r.stage, normalized: r.normalized, score: r.score ?? null, ingestionId: r.ingestion_id,
  duplicateOf: r.duplicate_of, createdAt: r.created_at, updatedAt: r.updated_at,
});
const toApp = (r: Row): ApplicationRow => ({
  id: r.id, ctx: ctxOf(r), jobId: r.job_id, idempotencyKey: r.idempotency_key, status: r.status, confirmed: r.confirmed,
  resumeVersionId: r.resume_version_id, coverLetterId: r.cover_letter_id, evidence: r.evidence, submittedAt: r.submitted_at,
  attempts: r.attempts, lastError: r.last_error,
});
const toException = (r: Row): ExceptionRow => ({
  id: r.id, ctx: ctxOf(r), type: r.type, entityType: r.entity_type, entityId: r.entity_id, detail: r.detail, resolvedAt: r.resolved_at, createdAt: r.created_at,
});
const toCompany = (r: Row): CompanyRow => ({ id: r.id, ctx: ctxOf(r), name: r.name, domain: r.domain, research: r.research, researchedAt: r.researched_at });
const toContact = (r: Row): ContactRow => ({
  id: r.id, ctx: ctxOf(r), companyId: r.company_id, name: r.name, title: r.title, email: r.email, linkedinUrl: r.linkedin_url,
  relevance: Number(r.relevance), source: r.source, suppressed: r.suppressed, suppressReason: r.suppress_reason,
});
const toOutreach = (r: Row): OutreachRow => ({
  id: r.id, ctx: ctxOf(r), contactId: r.contact_id, jobId: r.job_id, step: r.step, channel: r.channel, status: r.status,
  subject: r.subject, body: r.body, scheduledFor: r.scheduled_for, sentAt: r.sent_at, threadId: r.thread_id, stopReason: r.stop_reason,
});
const toResume = (r: Row): ResumeVersionRow => ({
  id: r.id, ctx: ctxOf(r), jobId: r.job_id, archetype: r.archetype, evidenceIds: r.evidence_ids, relevanceScore: Number(r.relevance_score),
  factualConfidence: Number(r.factual_confidence), storagePath: r.storage_path, contentJson: r.content_json, createdAt: r.created_at,
});

const APP_COLS: Record<string, string> = {
  status: "status", confirmed: "confirmed", resumeVersionId: "resume_version_id", coverLetterId: "cover_letter_id",
  evidence: "evidence", submittedAt: "submitted_at", attempts: "attempts", lastError: "last_error",
};
const OUT_COLS: Record<string, string> = {
  step: "step", status: "status", subject: "subject", body: "body", scheduledFor: "scheduled_for", sentAt: "sent_at",
  threadId: "thread_id", stopReason: "stop_reason", jobId: "job_id",
};
function mapPatch(patch: Record<string, unknown>, cols: Record<string, string>) {
  const out: Row = {};
  for (const [k, v] of Object.entries(patch)) if (k in cols && v !== undefined) out[cols[k]!] = v;
  return out;
}

/** Store backed by Supabase using the service role. RLS is bypassed, so EVERY query carries explicit tenant_id + user_id filters. */
export class SupabaseStore implements Store {
  constructor(readonly sb: SupabaseClient = createServiceClient()) {}

  // ------------------------------------------------------------ preferences
  async getPreferences(ctx: Ctx) {
    const [p, a] = await Promise.all([
      this.sb.from("profiles").select("preferences").match(scope(ctx)).maybeSingle(),
      this.sb.from("automation_policies").select("policy").match(scope(ctx)).maybeSingle(),
    ]);
    if (p.error) fail("getPreferences", p.error);
    if (a.error) fail("getPreferences", a.error);
    const prefs: Row = (p.data?.preferences as Row) ?? {};
    return Preferences.parse({ ...prefs, policy: { ...(prefs.policy ?? {}), ...((a.data?.policy as Row) ?? {}) } });
  }
  async setPreferences(ctx: Ctx, patch: Partial<Preferences>) {
    const next = Preferences.parse({ ...(await this.getPreferences(ctx)), ...patch });
    const p = await this.sb.from("profiles").upsert({ ...scope(ctx), preferences: next }, { onConflict: "tenant_id,user_id" });
    if (p.error) fail("setPreferences", p.error);
    const a = await this.sb.from("automation_policies").upsert({ ...scope(ctx), policy: next.policy }, { onConflict: "tenant_id,user_id" });
    if (a.error) fail("setPreferences", a.error);
    return next;
  }

  // ------------------------------------------------------------ ingestion
  async createIngestion(ctx: Ctx, req: IngestRequest) {
    const find = async () => {
      if (!req.idempotencyKey) return null;
      const { data, error } = await this.sb.from("ingestions").select("*").match(scope(ctx)).eq("idempotency_key", req.idempotencyKey).maybeSingle();
      if (error) fail("createIngestion.find", error);
      return data ? toIngestion(data) : null;
    };
    const existing = await find();
    if (existing) return existing;
    const { data, error } = await this.sb.from("ingestions")
      .insert({ ...scope(ctx), request: req, source: req.source, idempotency_key: req.idempotencyKey ?? null }).select("*").single();
    if (error) {
      if (error.code === UNIQUE_VIOLATION) { const again = await find(); if (again) return again; }
      fail("createIngestion", error);
    }
    return toIngestion(data!);
  }
  async getIngestion(ctx: Ctx, id: string) {
    const { data, error } = await this.sb.from("ingestions").select("*").match(scope(ctx)).eq("id", id).maybeSingle();
    if (error) fail("getIngestion", error);
    return data ? toIngestion(data) : null;
  }
  async updateIngestion(ctx: Ctx, id: string, patch: Partial<Pick<IngestionRow, "status" | "jobId" | "error" | "attempts">>) {
    const row: Row = {};
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.jobId !== undefined) row.job_id = patch.jobId;
    if (patch.error !== undefined) row.error = patch.error;
    if (patch.attempts !== undefined) row.attempts = patch.attempts;
    const { error } = await this.sb.from("ingestions").update(row).match(scope(ctx)).eq("id", id);
    if (error) fail("updateIngestion", error);
  }
  async claimIngestions(limit: number) {
    const sel = await this.sb.from("ingestions").select("id").eq("status", "accepted").order("created_at").limit(limit);
    if (sel.error) fail("claimIngestions", sel.error);
    const ids = (sel.data ?? []).map((r: Row) => r.id);
    if (!ids.length) return [];
    // conditional update: only rows still 'accepted' are claimed, so concurrent workers never double-claim
    const { data, error } = await this.sb.from("ingestions").update({ status: "processing" }).in("id", ids).eq("status", "accepted").select("*");
    if (error) fail("claimIngestions", error);
    return (data ?? []).map(toIngestion);
  }

  // ------------------------------------------------------------ jobs
  async upsertJob(ctx: Ctx, ingestionId: string, normalized: NormalizedJob) {
    const byIngestion = async () => {
      const { data, error } = await this.sb.from("jobs").select("*").match(scope(ctx)).eq("ingestion_id", ingestionId).maybeSingle();
      if (error) fail("upsertJob.byIngestion", error);
      return data ? toJob(data) : null;
    };
    const ex = await byIngestion();
    if (ex) return { job: ex, duplicate: ex.stage === "duplicate" };
    const orig = await this.sb.from("jobs").select("id").match(scope(ctx)).eq("dedupe_key", normalized.dedupeKey).is("duplicate_of", null).maybeSingle();
    if (orig.error) fail("upsertJob.orig", orig.error);
    const base = { ...scope(ctx), ingestion_id: ingestionId, normalized, dedupe_key: normalized.dedupeKey };
    const ins = await this.sb.from("jobs")
      .insert(orig.data ? { ...base, stage: "duplicate", duplicate_of: orig.data.id } : { ...base, stage: "normalized" }).select("*").single();
    if (ins.error) {
      if (ins.error.code === UNIQUE_VIOLATION) {
        const again = await byIngestion();
        if (again) return { job: again, duplicate: again.stage === "duplicate" };
        // lost a race on the dedupe index: retry once as a duplicate of the winner
        const w = await this.sb.from("jobs").select("id").match(scope(ctx)).eq("dedupe_key", normalized.dedupeKey).is("duplicate_of", null).maybeSingle();
        if (w.data) {
          const r2 = await this.sb.from("jobs").insert({ ...base, stage: "duplicate", duplicate_of: w.data.id }).select("*").single();
          if (!r2.error) return { job: toJob(r2.data!), duplicate: true };
        }
      }
      fail("upsertJob", ins.error);
    }
    return { job: toJob(ins.data!), duplicate: !!orig.data };
  }
  async setJobStage(ctx: Ctx, jobId: string, stage: JobStage, score?: ScoreBreakdown) {
    const row: Row = { stage };
    if (score) { row.score = score; row.score_total = score.total; }
    const { error } = await this.sb.from("jobs").update(row).match(scope(ctx)).eq("id", jobId);
    if (error) fail("setJobStage", error);
  }
  async getJob(ctx: Ctx, id: string) {
    const { data, error } = await this.sb.from("jobs").select("*").match(scope(ctx)).eq("id", id).maybeSingle();
    if (error) fail("getJob", error);
    return data ? toJob(data) : null;
  }
  async searchJobs(ctx: Ctx, q: { text?: string; stage?: JobStage; minScore?: number; limit?: number }) {
    let qb = this.sb.from("jobs").select("*").match(scope(ctx));
    if (q.stage) qb = qb.eq("stage", q.stage);
    if (q.minScore != null) qb = qb.gte("score_total", q.minScore);
    if (q.text) {
      const t = q.text.replace(/[,()%*]/g, " ").trim();
      if (t) qb = qb.or(`title.ilike.%${t}%,company.ilike.%${t}%,normalized->>description.ilike.%${t}%`);
    }
    const { data, error } = await qb.order("created_at", { ascending: false }).limit(q.limit ?? 50);
    if (error) fail("searchJobs", error);
    return (data ?? []).map(toJob);
  }
  async pipelineCounts(ctx: Ctx) {
    const out = Object.fromEntries(JobStage.options.map((s) => [s, 0])) as Record<JobStage, number>;
    const { data, error } = await this.sb.from("jobs").select("stage").match(scope(ctx));
    if (error) fail("pipelineCounts", error);
    for (const r of data ?? []) if (r.stage in out) out[r.stage as JobStage]++;
    return out;
  }

  // ------------------------------------------------------------ applications
  async getOrCreateApplication(ctx: Ctx, jobId: string) {
    const find = async () => {
      const { data, error } = await this.sb.from("applications").select("*").eq("tenant_id", ctx.tenantId).eq("user_id", ctx.userId).eq("job_id", jobId).maybeSingle();
      if (error) fail("getOrCreateApplication.find", error);
      return data ? toApp(data) : null;
    };
    const ex = await find();
    if (ex) return { app: ex, created: false };
    const { data, error } = await this.sb.from("applications")
      .insert({ ...scope(ctx), job_id: jobId, idempotency_key: `${ctx.tenantId}:${jobId}` }).select("*").single();
    if (error) {
      if (error.code === UNIQUE_VIOLATION) { const again = await find(); if (again) return { app: again, created: false }; }
      fail("getOrCreateApplication", error);
    }
    return { app: toApp(data!), created: true };
  }
  async updateApplication(ctx: Ctx, id: string, patch: Partial<ApplicationRow>) {
    if (patch.confirmed && !patch.evidence) {
      const cur = await this.sb.from("applications").select("evidence").match(scope(ctx)).eq("id", id).maybeSingle();
      if (!cur.data?.evidence) throw new Error("confirmed=true requires evidence");
    }
    const { error } = await this.sb.from("applications").update(mapPatch(patch, APP_COLS)).match(scope(ctx)).eq("id", id);
    if (error) fail("updateApplication", error);
  }
  async getApplicationByJob(ctx: Ctx, jobId: string) {
    const { data, error } = await this.sb.from("applications").select("*").match(scope(ctx)).eq("job_id", jobId).maybeSingle();
    if (error) fail("getApplicationByJob", error);
    return data ? toApp(data) : null;
  }
  async saveResumeVersion(ctx: Ctx, r: Omit<ResumeVersionRow, "id" | "createdAt">) {
    const { data, error } = await this.sb.from("resume_versions").insert({
      ...scope(ctx), job_id: r.jobId, archetype: r.archetype, evidence_ids: r.evidenceIds, relevance_score: r.relevanceScore,
      factual_confidence: r.factualConfidence, storage_path: r.storagePath, content_json: r.contentJson,
    }).select("*").single();
    if (error) fail("saveResumeVersion", error);
    return toResume(data!);
  }

  // ------------------------------------------------------------ exceptions
  async raiseException(ctx: Ctx, e: Omit<ExceptionRow, "id" | "createdAt" | "resolvedAt">) {
    const { data, error } = await this.sb.from("exceptions").insert({ ...scope(ctx), type: e.type, entity_type: e.entityType, entity_id: e.entityId, detail: e.detail }).select("*").single();
    if (error) fail("raiseException", error);
    return toException(data!);
  }
  async listExceptions(ctx: Ctx, openOnly = false) {
    let qb = this.sb.from("exceptions").select("*").match(scope(ctx));
    if (openOnly) qb = qb.is("resolved_at", null);
    const { data, error } = await qb.order("created_at", { ascending: false });
    if (error) fail("listExceptions", error);
    return (data ?? []).map(toException);
  }

  async resolveException(ctx: Ctx, id: string) {
    const { data, error } = await this.sb.from("exceptions").update({ resolved_at: new Date().toISOString() })
      .match(scope(ctx)).eq("id", id).is("resolved_at", null).select("id");
    if (error) fail("resolveException", error);
    if (data?.length) return true;
    const ex = await this.sb.from("exceptions").select("id").match(scope(ctx)).eq("id", id).maybeSingle();
    if (ex.error) fail("resolveException.find", ex.error);
    return !!ex.data; // already resolved counts as success; unknown id in this tenant is false
  }

  // ------------------------------------------------------------ companies / contacts / outreach
  async upsertCompany(ctx: Ctx, name: string, domain: string | null) {
    const find = async () => {
      const { data, error } = await this.sb.from("companies").select("*").match(scope(ctx)).ilike("name", name.trim().replace(/[%_]/g, (m) => "\\" + m)).maybeSingle();
      if (error) fail("upsertCompany.find", error);
      return data as Row | null;
    };
    let row = await find();
    if (!row) {
      const ins = await this.sb.from("companies").insert({ ...scope(ctx), name: name.trim(), domain }).select("*").single();
      if (ins.error) { if (ins.error.code === UNIQUE_VIOLATION) row = await find(); if (!row) fail("upsertCompany", ins.error); } else row = ins.data;
    } else if (domain && !row.domain) {
      const u = await this.sb.from("companies").update({ domain }).match(scope(ctx)).eq("id", row.id).select("*").single();
      if (u.error) fail("upsertCompany.update", u.error);
      row = u.data;
    }
    return toCompany(row!);
  }
  async saveCompanyResearch(ctx: Ctx, companyId: string, research: unknown) {
    const { error } = await this.sb.from("companies").update({ research, researched_at: new Date().toISOString() }).match(scope(ctx)).eq("id", companyId);
    if (error) fail("saveCompanyResearch", error);
  }
  async getCompanyByName(ctx: Ctx, name: string) {
    const { data, error } = await this.sb.from("companies").select("*").match(scope(ctx)).ilike("name", name.trim().replace(/[%_]/g, (m) => "\\" + m)).maybeSingle();
    if (error) fail("getCompanyByName", error);
    return data ? toCompany(data) : null;
  }
  async upsertContact(ctx: Ctx, c: Omit<ContactRow, "id" | "suppressed" | "suppressReason">) {
    const { data: rows, error } = await this.sb.from("contacts").select("*").match(scope(ctx)).eq("company_id", c.companyId);
    if (error) fail("upsertContact.find", error);
    const hit = (rows ?? []).find((x: Row) => (c.email && x.email === c.email) || (c.linkedinUrl && x.linkedin_url === c.linkedinUrl) || x.name === c.name);
    const body = { company_id: c.companyId, name: c.name, title: c.title, email: c.email, linkedin_url: c.linkedinUrl, relevance: c.relevance, source: c.source };
    const res = hit
      ? await this.sb.from("contacts").update(body).match(scope(ctx)).eq("id", hit.id).select("*").single()
      : await this.sb.from("contacts").insert({ ...scope(ctx), ...body }).select("*").single();
    if (res.error) fail("upsertContact", res.error);
    return toContact(res.data!);
  }
  async listContacts(ctx: Ctx, companyId: string) {
    const { data, error } = await this.sb.from("contacts").select("*").match(scope(ctx)).eq("company_id", companyId).order("relevance", { ascending: false });
    if (error) fail("listContacts", error);
    return (data ?? []).map(toContact);
  }
  async suppressContact(ctx: Ctx, contactId: string, reason: string) {
    const c = await this.sb.from("contacts").update({ suppressed: true, suppress_reason: reason }).match(scope(ctx)).eq("id", contactId);
    if (c.error) fail("suppressContact", c.error);
    const o = await this.sb.from("outreach_messages").update({ status: "stopped", stop_reason: reason })
      .match(scope(ctx)).eq("contact_id", contactId).in("status", ["draft", "scheduled"]);
    if (o.error) fail("suppressContact.outreach", o.error);
  }
  async createOutreach(ctx: Ctx, o: Omit<OutreachRow, "id" | "sentAt" | "stopReason" | "threadId">) {
    const { data, error } = await this.sb.from("outreach_messages").insert({
      ...scope(ctx), contact_id: o.contactId, job_id: o.jobId, step: o.step, channel: o.channel, status: o.status,
      subject: o.subject, body: o.body, scheduled_for: o.scheduledFor,
    }).select("*").single();
    if (error) fail("createOutreach", error);
    return toOutreach(data!);
  }
  async updateOutreach(ctx: Ctx, id: string, patch: Partial<OutreachRow>) {
    const { error } = await this.sb.from("outreach_messages").update(mapPatch(patch, OUT_COLS)).match(scope(ctx)).eq("id", id);
    if (error) fail("updateOutreach", error);
  }
  async listOutreach(ctx: Ctx, q: { jobId?: string; contactId?: string; dueBefore?: string }) {
    let qb = this.sb.from("outreach_messages").select("*").match(scope(ctx));
    if (q.jobId) qb = qb.eq("job_id", q.jobId);
    if (q.contactId) qb = qb.eq("contact_id", q.contactId);
    if (q.dueBefore) qb = qb.lte("scheduled_for", q.dueBefore);
    const { data, error } = await qb.order("created_at");
    if (error) fail("listOutreach", error);
    return (data ?? []).map(toOutreach);
  }

  // ------------------------------------------------------------ events / external actions
  async logEvent(ctx: Ctx, kind: string, entityType: string, entityId: string | null, payload: Record<string, unknown> = {}) {
    const { error } = await this.sb.from("events").insert({ ...scope(ctx), kind, entity_type: entityType, entity_id: entityId, payload });
    if (error) fail("logEvent", error);
  }
  async listEvents(ctx: Ctx, q: { entityId?: string; kind?: string; limit?: number }) {
    let qb = this.sb.from("events").select("*").match(scope(ctx));
    if (q.entityId) qb = qb.eq("entity_id", q.entityId);
    if (q.kind) qb = qb.eq("kind", q.kind);
    const { data, error } = await qb.order("created_at", { ascending: false }).limit(q.limit ?? 100);
    if (error) fail("listEvents", error);
    return (data ?? []).reverse().map((r: Row): EventRecord => ({
      id: r.id, tenantId: r.tenant_id, userId: r.user_id, kind: r.kind, entityType: r.entity_type, entityId: r.entity_id, payload: r.payload, createdAt: r.created_at,
    }));
  }
  async recordExternalAction(ctx: Ctx, a: { system: string; action: string; status: ExternalActionStatus; entityId?: string; detail?: string }) {
    const { error } = await this.sb.from("external_actions").insert({ ...scope(ctx), system: a.system, action: a.action, status: a.status, entity_id: a.entityId ?? null, detail: a.detail ?? null });
    if (error) fail("recordExternalAction", error);
  }
}
