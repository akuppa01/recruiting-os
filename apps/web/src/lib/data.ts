// Data adapter used by every page. Demo mode (no Supabase env) serves clearly-labelled fixtures from process memory.
// Otherwise every read is scoped to the tenant derived from the verified cookie session. No demo rows ever leak into prod.
import type { JobStage } from "@ros/core";
import { SupabaseStore, hasSupabaseEnv } from "@ros/db";
import * as demo from "./demo-data";
import { getStore } from "./store";
import { getSessionCtx } from "./session-ctx";
import { readTracking } from "./tracking";
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
  const [ex, jobs] = await Promise.all([l.store.listExceptions(l.ctx), l.store.searchJobs(l.ctx, { limit: 500 })]);
  const name = new Map(jobs.map((j) => [j.id, j.normalized.company]));
  return ex.map((e) => ({
    id: e.id, type: e.type, detail: e.detail, entity: (e.entityId && name.get(e.entityId)) || e.entityType,
    createdAt: e.createdAt, resolved: !!e.resolvedAt,
  }));
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
