// Data adapter used by every page. Demo mode (no Supabase env) serves clearly-labelled fixtures from process memory.
// Otherwise every read is scoped to the tenant derived from the verified cookie session. No demo rows ever leak into prod.
import { DEFAULT_LIMITS, type Ctx, type JobStage } from "@ros/core";
import { SupabaseStore, hasSupabaseEnv } from "@ros/db";
import * as demo from "./demo-data";
import { getStore } from "./store";
import { getSessionCtx } from "./session-ctx";
import { readTracking } from "./tracking";
import {
  derivePhase, estimateN8nExecutions, exceptionJobId, mergeLimits, nextAction, queueDepth, retryEligibility, sourceLabel, spendStatus,
  summarizeApplyStats, summarizeBrowserRuns, summarizeRun, summarizeUsage, workerStatus,
  type ApplyRecord, type ApplyStats, type LimitsLike, type PhaseOrClosed, type QueueDepth, type RunSummary, type TaskLite, type UsageRow, type UsageSummary,
} from "./pipeline-view";
export type { JobView, CompanyView, ApplicationView, ContactView, ExceptionView, ProofView, UpdateView } from "./demo-data";

export const isDemoMode = () => !hasSupabaseEnv();

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

async function live() {
  const ctx = await getSessionCtx();
  if (!ctx) return null;
  const store = getStore();
  if (!(store instanceof SupabaseStore)) return null;
  return { ctx, store, sb: store.sb };
}
const scope = (c: { tenantId: string; userId: string }) => ({ tenant_id: c.tenantId, user_id: c.userId });
const check = (op: string, error: { message: string } | null) => { if (error) throw new Error(`data.${op}: ${error.message}`); };

export async function getJobs(): Promise<demo.JobView[]> {
  const l = await live();
  if (!l) return isDemoMode() ? demoJobsFromStore() : [];
  const rows = await l.store.searchJobs(l.ctx, { limit: 500 });
  return rows.map(toJobView);
}

async function demoJobsFromStore(): Promise<demo.JobView[]> {
  const { getStoreAsync, DEMO_CTX } = await import("./store");
  const rows = await (await getStoreAsync()).searchJobs(DEMO_CTX, { limit: 200 });
  return rows.map(toJobView);
}

function toJobView(r: Awaited<ReturnType<SupabaseStore["searchJobs"]>>[number]): demo.JobView {
  return {
    id: r.id, title: r.normalized.title, company: r.normalized.company, location: r.normalized.location ?? "—",
    stage: r.stage, roleCategory: r.normalized.roleCategory, score: r.score?.total ?? null, deadline: r.normalized.deadline,
    salary: r.normalized.salaryMin ? `$${r.normalized.salaryMin}${r.normalized.salaryMax && r.normalized.salaryMax !== r.normalized.salaryMin ? `–${r.normalized.salaryMax}` : ""}` : null,
    atsKind: r.normalized.atsKind,
    breakdown: r.score ? { roleFit: r.score.roleFit, comp: r.score.comp, conversion: r.score.conversion, responsibility: r.score.responsibility, flexibility: r.score.flexibility, upside: r.score.upside, entrepreneurialCompat: r.score.entrepreneurialCompat } : null,
    rationale: r.score?.rationale ?? null, updatedAt: r.updatedAt,
    applyUrl: r.normalized.applyUrl ?? r.normalized.sourceUrl ?? null, tracking: readTracking(r.normalized),
  };
}

const SECTIONS = ["product", "strategy", "market", "news", "competitors", "hiringContext", "businessProblems"] as const;

export async function getCompanies(): Promise<demo.CompanyView[]> {
  const l = await live();
  if (!l) return isDemoMode() ? demo.demoCompanies : [];
  const { data, error } = await l.sb.from("companies").select("*").match(scope(l.ctx)).order("created_at", { ascending: false });
  check("getCompanies", error);
  return (data ?? []).map((c: Row): demo.CompanyView => {
    const r = c.research as Row | null;
    const findings: demo.CompanyView["findings"] = [];
    if (r) {
      for (const k of SECTIONS) for (const cl of (r[k] ?? []) as Row[]) {
        findings.push({ text: cl.text, basis: cl.kind, source: cl.sources?.[0]?.url });
      }
      for (const i of (r.ideas ?? []) as Row[]) findings.push({ text: `${i.title}: ${i.rationale}`, basis: i.kind ?? "speculation", source: i.sources?.[0]?.url });
    }
    return { id: c.id, name: c.name, domain: c.domain, researchedAt: c.researched_at, findings };
  });
}

export async function getApplications(): Promise<demo.ApplicationView[]> {
  const l = await live();
  if (!l) return isDemoMode() ? demo.demoApplications : [];
  const { data, error } = await l.sb.from("applications")
    .select("*, jobs(normalized), resume_versions(archetype, relevance_score, factual_confidence)")
    .match(scope(l.ctx)).order("created_at", { ascending: false });
  check("getApplications", error);
  return (data ?? []).map((a: Row): demo.ApplicationView => {
    const n = a.jobs?.normalized ?? {};
    const ev = a.evidence as Row | null;
    return {
      id: a.id, jobId: a.job_id, title: n.title ?? "Unknown role", company: n.company ?? "Unknown company",
      status: a.status, confirmed: a.confirmed,
      evidence: ev ? [ev.kind, ev.detail].filter(Boolean).join(": ") : null,
      resume: a.resume_versions?.archetype?.replace(/_/g, " ") ?? null,
      relevance: a.resume_versions ? Number(a.resume_versions.relevance_score) : null,
      factualConfidence: a.resume_versions ? Number(a.resume_versions.factual_confidence) : null,
      mode: a.status === "dry_run" ? "dry_run" : "live",
      at: a.submitted_at ?? a.created_at,
    };
  });
}

export async function getContacts(): Promise<demo.ContactView[]> {
  const l = await live();
  if (!l) return isDemoMode() ? demo.demoContacts : [];
  const [c, o] = await Promise.all([
    l.sb.from("contacts").select("*, companies(name)").match(scope(l.ctx)).order("relevance", { ascending: false }),
    l.sb.from("outreach_messages").select("contact_id, step, status, scheduled_for, sent_at").match(scope(l.ctx)).order("step"),
  ]);
  check("getContacts", c.error); check("getContacts.outreach", o.error);
  return (c.data ?? []).map((x: Row): demo.ContactView => ({
    id: x.id, name: x.name, title: x.title ?? "", company: x.companies?.name ?? "", relevance: Number(x.relevance),
    suppressed: x.suppressed, suppressReason: x.suppress_reason,
    sequence: (o.data ?? []).filter((m: Row) => m.contact_id === x.id).map((m: Row) => ({ step: m.step, status: m.status, when: m.sent_at ?? m.scheduled_for })),
  }));
}

export async function getExceptions(): Promise<demo.ExceptionView[]> {
  const l = await live();
  if (!l) return isDemoMode() ? demo.demoExceptions : [];
  const [ex, jobs, apps] = await Promise.all([
    l.store.listExceptions(l.ctx), l.store.searchJobs(l.ctx, { limit: 500 }),
    rowsOf(l.sb.from("applications").select("id, job_id, status, confirmed").match(scope(l.ctx))),
  ]);
  const name = new Map(jobs.map((j) => [j.id, j.normalized.company]));
  const jobOfApp = new Map(apps.map((a) => [String(a.id), String(a.job_id)]));
  const appByJob = new Map(apps.map((a) => [String(a.job_id), { status: String(a.status), confirmed: !!a.confirmed }]));
  return ex.map((e): demo.ExceptionView => {
    const jobId = exceptionJobId(e, jobOfApp);
    const eligibility = jobId ? retryEligibility(appByJob.get(jobId) ?? null) : null;
    const open = !e.resolvedAt;
    return {
      id: e.id, type: e.type, detail: e.detail, entity: (jobId && name.get(jobId)) || (e.entityId && name.get(e.entityId)) || e.entityType,
      createdAt: e.createdAt, resolved: !open,
      jobId, canRetry: open && !!jobId && eligibility?.ok === true, canSkip: open && !!jobId,
      retryBlockedReason: eligibility && !eligibility.ok ? eligibility.reason : null,
    };
  });
}

// ------------------------------------------------------------------ Today run summary
export async function getRunSummary(): Promise<RunSummary> {
  const empty = { sources: [], discoverTasks: [], applyTasks: [], apps: [], openExceptions: 0 };
  const l = await live();
  if (!l) return summarizeRun(empty);
  const [sources, tasks, apps, open] = await Promise.all([
    getSourceHealth(),
    rowsOf(l.sb.from("tasks").select("kind, status, updated_at").match(scope(l.ctx)).in("kind", ["discover", "apply"]).order("created_at", { ascending: false }).limit(500)),
    rowsOf(l.sb.from("applications").select("status, confirmed").match(scope(l.ctx))),
    l.store.listExceptions(l.ctx, true),
  ]);
  return summarizeRun({
    sources: sources.map((s) => ({ lastAttemptAt: s.lastAttemptAt, itemsLastRun: s.itemsLastRun })),
    discoverTasks: tasks.filter((t) => t.kind === "discover").map((t) => ({ status: String(t.status), updatedAt: t.updated_at ?? null })),
    applyTasks: tasks.filter((t) => t.kind === "apply").map((t) => ({ status: String(t.status) })),
    apps: apps.map((a) => ({ status: String(a.status), confirmed: !!a.confirmed })),
    openExceptions: open.length,
  });
}

// ------------------------------------------------------------------ Usage and limits
export interface SpendView { spentUsd: number; limitUsd: number; pct: number | null; level: "ok" | "warn" | "over" }
export interface UsageView {
  hasData: boolean;
  summary: UsageSummary;
  limits: LimitsLike;
  spend: { daily: SpendView; monthly: SpendView };
  applications: { processed: number; attempted: number; confirmed: number; unverified: number; failed: number; successRate: number | null };
  browser: { runs: number; succeeded: number; failed: number };
  /** n8n exposes no usage to us: this is derived from the workflow schedules and is always an estimate. */
  n8n: { kind: "estimate"; perDay: number; perMonth: number; workflows: Array<{ name: string; runsPerDay: number }> };
  generatedAt: string;
}

/** Supabase caps one request at 1,000 rows, so large tables are read page by page. */
async function pagedRows(page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, max = 20000): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; from < max; from += 1000) {
    const rows = await rowsOf(page(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

/** Tenant-scoped usage readout. Takes an explicit ctx so the page (cookie session) and /api/usage (any auth) share one implementation. */
export async function computeUsage(sb: SupabaseStore["sb"], ctx: Ctx, now: number = Date.now()): Promise<UsageView> {
  const [usageRows, apps, applyTasks, prefs] = await Promise.all([
    pagedRows((from, to) => sb.from("usage_events").select("metric, quantity, cost_usd, ref, created_at").match(scope(ctx)).order("created_at", { ascending: false }).range(from, to)),
    rowsOf(sb.from("applications").select("status, confirmed").match(scope(ctx))),
    rowsOf(sb.from("tasks").select("status").match(scope(ctx)).eq("kind", "apply").limit(5000)),
    rowsOf(sb.from("profiles").select("preferences").match(scope(ctx)).limit(1)),
  ]);
  const rows: UsageRow[] = usageRows.map((r) => ({
    metric: String(r.metric), quantity: Number(r.quantity ?? 0), costUsd: Number(r.cost_usd ?? 0),
    ref: r.ref == null ? null : String(r.ref), createdAt: String(r.created_at),
  }));
  const summary = summarizeUsage(rows, now);
  const limits = mergeLimits((prefs[0]?.preferences as Row | undefined)?.limits, DEFAULT_LIMITS);
  const stats = summarizeApplyStats(apps.map((a): ApplyRecord => ({ status: String(a.status), confirmed: !!a.confirmed, provider: null, strategy: null })));
  const spent = (s: { measuredUsd: number; estimatedUsd: number }) => s.measuredUsd + s.estimatedUsd;
  const spend = (spentUsd: number, limitUsd: number): SpendView => ({ spentUsd, limitUsd, ...spendStatus(spentUsd, limitUsd) });
  return {
    hasData: rows.length > 0 || apps.length > 0 || applyTasks.length > 0,
    summary, limits,
    spend: { daily: spend(spent(summary.today), limits.dailyAiUsd), monthly: spend(spent(summary.month), limits.monthlyAiUsd) },
    applications: {
      processed: apps.filter((a) => String(a.status) !== "pending").length, attempted: stats.attempted,
      confirmed: stats.confirmed, unverified: stats.unverified, failed: stats.failed, successRate: stats.successRate,
    },
    browser: summarizeBrowserRuns(applyTasks.map((t) => ({ status: String(t.status) }))),
    n8n: { kind: "estimate", ...estimateN8nExecutions() },
    generatedAt: new Date(now).toISOString(),
  };
}

/** Usage for the signed-in user. Demo mode and signed-out requests get a zeroed view (never invented numbers). */
export async function getUsage(): Promise<UsageView> {
  const l = await live();
  if (!l) {
    const summary = summarizeUsage([]);
    const limits = { ...DEFAULT_LIMITS };
    const zero = (limitUsd: number): SpendView => ({ spentUsd: 0, limitUsd, ...spendStatus(0, limitUsd) });
    return {
      hasData: false, summary, limits, spend: { daily: zero(limits.dailyAiUsd), monthly: zero(limits.monthlyAiUsd) },
      applications: { processed: 0, attempted: 0, confirmed: 0, unverified: 0, failed: 0, successRate: null },
      browser: { runs: 0, succeeded: 0, failed: 0 }, n8n: { kind: "estimate", ...estimateN8nExecutions() }, generatedAt: new Date().toISOString(),
    };
  }
  return computeUsage(l.sb, l.ctx);
}

// No proof_assets table exists yet (tracked in TASKS.md); never fabricate rows.
export async function getProofs(): Promise<demo.ProofView[]> {
  return isDemoMode() ? demo.demoProofs : [];
}

const UPDATE_KIND: Record<string, demo.UpdateView["kind"]> = { interview: "interview", rejection: "rejection", opt_out: "reply", reply: "reply" };

export async function getUpdates(): Promise<demo.UpdateView[]> {
  const l = await live();
  if (!l) return isDemoMode() ? demo.demoUpdates : [];
  const ev = await l.store.listEvents(l.ctx, { kind: "reply.received", limit: 50 });
  return ev.reverse().map((e) => {
    const cls = String(e.payload.class ?? "reply");
    return { id: e.id, kind: UPDATE_KIND[cls] ?? "reply", text: `Inbound ${cls.replace(/_/g, " ")} received.`, at: e.createdAt };
  });
}

export const STAGE_LABEL: Record<JobStage, string> = {
  ingested: "Ingested", normalized: "Normalized", duplicate: "Duplicate", researched: "Researched", scored: "Scored",
  archived: "Archived", qualified: "Qualified", applying: "Applying", applied: "Applied", needs_human: "Needs you",
  interviewing: "Interviewing", offer: "Offer", rejected: "Rejected", withdrawn: "Withdrawn",
};
export const BOARD_STAGES: JobStage[] = ["ingested", "scored", "qualified", "applied", "needs_human", "interviewing", "offer", "archived"];

export const ROLE_LABEL: Record<string, string> = {
  product_management: "Product management", product_marketing: "Product marketing", gtm_strategy: "GTM strategy",
  founders_office: "Founder's office", bizops_corp_strategy: "Business ops and strategy", growth_brand: "Growth and brand",
  ai_strategy: "AI strategy", strategic_partnerships: "Strategic partnerships", vc_pe_search: "VC, PE and search", other: "Other",
};

export function ago(iso: string) {
  const h = Math.round((Date.now() - new Date(iso).getTime()) / 3600_000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// ------------------------------------------------------------------ V3 pipeline state
// Every reader is tenant-scoped (tenant_id + user_id) and derives from real rows. When a table is empty or unreadable the
// result is empty, never invented. Demo mode and signed-out requests return empties.

async function rowsOf(p: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<Row[]> {
  const r = await p;
  if (r.error) { console.error("[data] V3 read failed:", r.error.message); return []; }
  return (r.data as Row[] | null) ?? [];
}

export interface SourceHealthView {
  source: string; label: string; status: "ok" | "degraded" | "failed" | "not_configured";
  lastAttemptAt: string | null; lastSuccessAt: string | null; lastError: string | null; itemsLastRun: number; itemsTotal: number;
}

export async function getSourceHealth(): Promise<SourceHealthView[]> {
  const l = await live();
  if (!l) return [];
  const data = await rowsOf(l.sb.from("source_health").select("*").match(scope(l.ctx)).order("source"));
  return data.map((r): SourceHealthView => ({
    source: String(r.source), label: sourceLabel(String(r.source)), status: r.status as SourceHealthView["status"],
    lastAttemptAt: r.last_attempt_at ?? null, lastSuccessAt: r.last_success_at ?? null, lastError: r.last_error ?? null,
    itemsLastRun: Number(r.items_last_run ?? 0), itemsTotal: Number(r.items_total ?? 0),
  }));
}

export interface TaskView extends TaskLite { attempts: number; maxAttempts: number; leaseUntil: string | null; createdAt: string }

const toTask = (r: Row): TaskView => ({
  id: String(r.id), kind: String(r.kind), status: String(r.status),
  jobId: typeof r.payload?.jobId === "string" ? r.payload.jobId : null,
  lastError: r.last_error ?? null, result: (r.result as Record<string, unknown> | null) ?? null,
  workerId: r.worker_id ?? null, updatedAt: r.updated_at ?? null, costUsd: Number(r.cost_usd ?? 0),
  attempts: Number(r.attempts ?? 0), maxAttempts: Number(r.max_attempts ?? 3), leaseUntil: r.lease_until ?? null, createdAt: String(r.created_at),
});

export async function getTasks(limit = 50): Promise<TaskView[]> {
  const l = await live();
  if (!l) return [];
  const data = await rowsOf(l.sb.from("tasks").select("*").match(scope(l.ctx)).order("created_at", { ascending: false }).limit(limit));
  return data.map(toTask);
}

export interface TaskLogView { id: string; taskId: string; kind: string | null; level: string; message: string; createdAt: string }

export async function getRecentTaskLogs(limit = 30): Promise<TaskLogView[]> {
  const l = await live();
  if (!l) return [];
  const data = await rowsOf(l.sb.from("task_logs").select("*, tasks(kind)").match(scope(l.ctx)).order("created_at", { ascending: false }).limit(limit));
  return data.map((r): TaskLogView => ({
    id: String(r.id), taskId: String(r.task_id), kind: r.tasks?.kind ?? null, level: String(r.level), message: String(r.message), createdAt: String(r.created_at),
  }));
}

export interface WorkerView { workerId: string; host: string | null; kinds: string[]; currentTask: string | null; lastSeen: string; startedAt: string; status: "online" | "offline" }

/** worker_heartbeats has no tenant column (workers are shared infrastructure), so this lists every registered worker. */
export async function getWorkers(): Promise<WorkerView[]> {
  const l = await live();
  if (!l) return [];
  const data = await rowsOf(l.sb.from("worker_heartbeats").select("*").order("last_seen", { ascending: false }).limit(20));
  return data.map((r): WorkerView => ({
    workerId: String(r.worker_id), host: r.host ?? null, kinds: Array.isArray(r.kinds) ? r.kinds.map(String) : [],
    currentTask: r.current_task ?? null, lastSeen: String(r.last_seen), startedAt: String(r.started_at), status: workerStatus(r.last_seen ?? null),
  }));
}

export async function getApplyStats(): Promise<ApplyStats> {
  const l = await live();
  if (!l) return summarizeApplyStats([]);
  const [apps, tasks] = await Promise.all([
    rowsOf(l.sb.from("applications").select("status, confirmed, job_id, jobs(normalized)").match(scope(l.ctx))),
    rowsOf(l.sb.from("tasks").select("payload, result").match(scope(l.ctx)).eq("kind", "apply").order("created_at", { ascending: true }).limit(1000)),
  ]);
  const strategy = new Map<string, string>(); // oldest first, so the latest apply task per job wins
  for (const t of tasks) {
    const jobId = t.payload?.jobId; const s = t.result?.strategy;
    if (typeof jobId === "string" && typeof s === "string") strategy.set(jobId, s);
  }
  return summarizeApplyStats(apps.map((a): ApplyRecord => ({
    status: String(a.status), confirmed: !!a.confirmed,
    provider: typeof a.jobs?.normalized?.atsKind === "string" ? a.jobs.normalized.atsKind : null,
    strategy: strategy.get(String(a.job_id)) ?? null,
  })));
}

export interface JobPipelineView {
  jobId: string; company: string; title: string; source: string; sourceLabel: string; fitScore: number | null; deadline: string | null;
  phase: PhaseOrClosed; atsProvider: string; strategy: string | null; currentActivity: string | null;
  confirmation: string | null; failureReason: string | null; nextAction: string;
}

export async function getPipelineViews(): Promise<JobPipelineView[]> {
  const l = await live();
  if (!l) return [];
  const jobs = await l.store.searchJobs(l.ctx, { limit: 500 });
  if (!jobs.length) return [];
  const [ings, taskRows, apps, openEx] = await Promise.all([
    rowsOf(l.sb.from("ingestions").select("id, source, job_id").match(scope(l.ctx)).limit(2000)),
    rowsOf(l.sb.from("tasks").select("*").match(scope(l.ctx)).order("created_at", { ascending: false }).limit(1000)),
    rowsOf(l.sb.from("applications").select("id, job_id, status, confirmed, evidence, last_error").match(scope(l.ctx))),
    l.store.listExceptions(l.ctx, true),
  ]);
  const ingSource = new Map(ings.map((r) => [String(r.id), String(r.source)]));
  const jobByIngestion = new Map(ings.filter((r) => r.job_id).map((r) => [String(r.id), String(r.job_id)]));
  const appByJob = new Map(apps.map((a) => [String(a.job_id), a]));
  const jobOfApp = new Map(apps.map((a) => [String(a.id), String(a.job_id)]));

  const tasksByJob = new Map<string, TaskView[]>(); // newest first
  for (const r of taskRows) {
    const t = toTask(r);
    const viaIngestion = typeof r.payload?.ingestionId === "string" ? jobByIngestion.get(r.payload.ingestionId) ?? null : null;
    const jid = t.jobId ?? viaIngestion;
    if (!jid) continue;
    const arr = tasksByJob.get(jid) ?? [];
    arr.push({ ...t, jobId: jid });
    tasksByJob.set(jid, arr);
  }
  const exByJob = new Map<string, string>();
  for (const e of openEx) {
    const jid = e.entityType === "job" ? e.entityId : jobOfApp.get(e.entityId ?? "") ?? null;
    if (jid && !exByJob.has(jid)) exByJob.set(jid, e.detail);
  }

  return jobs.map((j): JobPipelineView => {
    const jt = tasksByJob.get(j.id) ?? [];
    const trackingStatus = readTracking(j.normalized).status;
    const active = jt.find((t) => t.status === "leased") ?? jt.find((t) => t.status === "queued") ?? null;
    const app = appByJob.get(j.id);
    const phase = derivePhase({ stage: j.stage, trackingStatus, tasks: jt });
    const exDetail = exByJob.get(j.id) ?? null;
    const failedTask = jt.find((t) => (t.status === "failed" || t.status === "dead") && t.lastError);
    const ev = app?.evidence as Row | null | undefined;
    const strategyTask = jt.find((t) => t.kind === "apply" && typeof t.result?.strategy === "string");
    const source = ingSource.get(j.ingestionId) ?? "unknown";
    return {
      jobId: j.id, company: j.normalized.company, title: j.normalized.title, source, sourceLabel: sourceLabel(source),
      fitScore: j.score?.total ?? null, deadline: j.normalized.deadline, phase, atsProvider: j.normalized.atsKind,
      strategy: strategyTask ? String(strategyTask.result?.strategy) : null,
      currentActivity: active ? `${active.kind} ${active.status === "leased" ? `running${active.workerId ? ` on ${active.workerId}` : ""}` : "queued"}` : null,
      confirmation: app?.confirmed && ev ? [ev.kind, ev.detail].filter(Boolean).join(": ") : null,
      failureReason: failedTask?.lastError ?? exDetail ?? (app && (app.status === "failed" || app.status === "unverified") ? app.last_error ?? null : null),
      nextAction: nextAction({ phase, stage: j.stage, trackingStatus, hasOpenException: !!exDetail, activeTaskKind: active?.kind ?? null, confirmed: !!app?.confirmed }),
    };
  });
}

export interface PipelineHealth { sources: SourceHealthView[]; workers: WorkerView[]; queue: QueueDepth; stats: ApplyStats; hasData: boolean }

export async function getPipelineHealth(): Promise<PipelineHealth> {
  const l = await live();
  const [sources, workers, stats] = await Promise.all([getSourceHealth(), getWorkers(), getApplyStats()]);
  const queueRows = l ? await rowsOf(l.sb.from("tasks").select("status").match(scope(l.ctx)).limit(5000)) : [];
  const queue = queueDepth(queueRows.map((r) => ({ status: String(r.status) })));
  return { sources, workers, queue, stats, hasData: sources.length > 0 || workers.length > 0 || queueRows.length > 0 || stats.attempted > 0 };
}
