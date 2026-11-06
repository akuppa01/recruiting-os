// Thin data adapter. When Agent A's `@/lib/store` lands, swap the bodies here to read from getStore();
// pages only import from this file. Demo mode is on whenever Supabase is not configured.
import type { JobStage } from "@ros/core";
import * as demo from "./demo-data";
export type { JobView, CompanyView, ApplicationView, ContactView, ExceptionView, ProofView, UpdateView } from "./demo-data";

export const isDemoMode = () => !process.env.NEXT_PUBLIC_SUPABASE_URL;

const empty = <T,>(): T[] => [];
const pick = <T,>(rows: T[]): T[] => (isDemoMode() ? rows : empty<T>());

export async function getJobs(): Promise<demo.JobView[]> {
  if (!isDemoMode()) return []; // no session UI yet: real tenants are served via the authenticated API only
  const { getStoreAsync, DEMO_CTX } = await import("./store");
  const rows = await (await getStoreAsync()).searchJobs(DEMO_CTX, { limit: 200 });
  return rows.map((r) => ({
    id: r.id, title: r.normalized.title, company: r.normalized.company, location: r.normalized.location ?? "—",
    stage: r.stage, roleCategory: r.normalized.roleCategory, score: r.score?.total ?? null, deadline: r.normalized.deadline,
    salary: r.normalized.salaryMin ? `$${r.normalized.salaryMin}${r.normalized.salaryMax && r.normalized.salaryMax !== r.normalized.salaryMin ? `–${r.normalized.salaryMax}` : ""}` : null,
    atsKind: r.normalized.atsKind,
    breakdown: r.score ? { roleFit: r.score.roleFit, comp: r.score.comp, conversion: r.score.conversion, responsibility: r.score.responsibility, flexibility: r.score.flexibility, upside: r.score.upside, entrepreneurialCompat: r.score.entrepreneurialCompat } : null,
    rationale: r.score?.rationale ?? null, updatedAt: r.updatedAt,
  }));
}
export async function getCompanies() { return pick(demo.demoCompanies); }
export async function getApplications() { return pick(demo.demoApplications); }
export async function getContacts() { return pick(demo.demoContacts); }
export async function getExceptions() { return pick(demo.demoExceptions); }
export async function getProofs() { return pick(demo.demoProofs); }
export async function getUpdates() { return pick(demo.demoUpdates); }

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
