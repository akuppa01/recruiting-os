// DEMO DATA ONLY. Fictional companies and people. Never shown unless the app is in demo mode.
import type { JobStage, ExceptionType, RoleCategory } from "@ros/core";
import type { Tracking } from "./tracking";

export interface JobView {
  id: string; title: string; company: string; location: string; stage: JobStage; roleCategory: RoleCategory;
  score: number | null; deadline: string | null; salary: string | null; atsKind: string;
  breakdown: { roleFit: number; comp: number; conversion: number; responsibility: number; flexibility: number; upside: number; entrepreneurialCompat: number } | null;
  rationale: string | null; updatedAt: string;
  applyUrl?: string | null; tracking?: Tracking | null;
}
export interface CompanyView {
  id: string; name: string; domain: string | null; researchedAt: string | null;
  findings: { text: string; basis: "sourced" | "inference" | "speculation"; source?: string }[];
}
export interface ApplicationView {
  id: string; jobId: string; title: string; company: string; status: "pending" | "succeeded" | "failed" | "unverified" | "dry_run";
  confirmed: boolean; evidence: string | null; resume: string | null; relevance: number | null; factualConfidence: number | null; mode: "dry_run" | "live"; at: string | null;
}
export interface ContactView {
  id: string; name: string; title: string; company: string; relevance: number; suppressed: boolean; suppressReason: string | null;
  sequence: { step: number; status: "draft" | "scheduled" | "sent" | "dry_run" | "failed" | "stopped"; when: string | null }[];
}
export interface ExceptionView {
  id: string; type: ExceptionType; detail: string; entity: string; createdAt: string; resolved: boolean;
  /** Set for exceptions that belong to a job; drives the Retry/Skip buttons in the Inbox. */
  jobId?: string | null; canRetry?: boolean; canSkip?: boolean; retryBlockedReason?: string | null;
}
export interface ProofView { id: string; company: string; title: string; status: "draft" | "preview_ready"; previewUrl: string | null; loomScript: boolean }
export interface UpdateView { id: string; kind: "reply" | "interview" | "rejection" | "deadline" | "system"; text: string; at: string }

const d = (n: number) => new Date(Date.now() - n * 3600_000).toISOString();

export const demoJobs: JobView[] = [
  { id: "j1", title: "Product Management Intern (MBA)", company: "Northwind Labs", location: "Remote, US", stage: "qualified", roleCategory: "product_management", score: 86, deadline: "2026-11-20", salary: "$58/hr", atsKind: "greenhouse",
    breakdown: { roleFit: 92, comp: 80, conversion: 85, responsibility: 88, flexibility: 90, upside: 82, entrepreneurialCompat: 70 }, rationale: "Core PM role, strong return-offer language in the posting.", updatedAt: d(2) },
  { id: "j2", title: "Founder's Office Intern", company: "Harbor AI", location: "San Francisco, CA", stage: "applied", roleCategory: "founders_office", score: 81, deadline: null, salary: null, atsKind: "ashby",
    breakdown: { roleFit: 84, comp: 60, conversion: 78, responsibility: 95, flexibility: 70, upside: 90, entrepreneurialCompat: 85 }, rationale: "Broad strategic scope at an early-stage AI company.", updatedAt: d(20) },
  { id: "j3", title: "Product Marketing Manager Intern", company: "Lumen Retail", location: "Chicago, IL", stage: "needs_human", roleCategory: "product_marketing", score: 74, deadline: "2026-12-01", salary: "$50/hr", atsKind: "lever",
    breakdown: { roleFit: 80, comp: 70, conversion: 72, responsibility: 70, flexibility: 65, upside: 72, entrepreneurialCompat: 60 }, rationale: "Good fit; application includes a sensitive eligibility question.", updatedAt: d(5) },
  { id: "j4", title: "GTM Strategy Intern", company: "Cobalt Systems", location: "New York, NY", stage: "interviewing", roleCategory: "gtm_strategy", score: 83, deadline: null, salary: "$62/hr", atsKind: "greenhouse",
    breakdown: { roleFit: 88, comp: 85, conversion: 80, responsibility: 82, flexibility: 60, upside: 85, entrepreneurialCompat: 55 }, rationale: "GTM strategy for a growing enterprise software company.", updatedAt: d(30) },
  { id: "j5", title: "Business Operations Intern", company: "Atlas Freight", location: "Dallas, TX", stage: "archived", roleCategory: "bizops_corp_strategy", score: 38, deadline: null, salary: null, atsKind: "other",
    breakdown: null, rationale: "Hard reject: on-site 5 days, not an MBA program.", updatedAt: d(48) },
  { id: "j6", title: "AI Strategy Associate Intern", company: "Meridian Health Tech", location: "Boston, MA", stage: "scored", roleCategory: "ai_strategy", score: 69, deadline: "2026-12-15", salary: null, atsKind: "workday",
    breakdown: { roleFit: 72, comp: 60, conversion: 70, responsibility: 68, flexibility: 70, upside: 70, entrepreneurialCompat: 65 }, rationale: "Relevant, mid-priority; Workday adapter not available.", updatedAt: d(8) },
  { id: "j7", title: "Strategic Partnerships Intern", company: "Pioneer Cloud", location: "Remote, US", stage: "ingested", roleCategory: "strategic_partnerships", score: null, deadline: null, salary: null, atsKind: "unknown", breakdown: null, rationale: null, updatedAt: d(0.2) },
];

export const demoCompanies: CompanyView[] = [
  { id: "c1", name: "Northwind Labs", domain: "northwindlabs.example", researchedAt: d(3), findings: [
    { text: "Sells workflow software to mid-market logistics teams.", basis: "sourced", source: "northwindlabs.example/about" },
    { text: "Announced a Series B in the past year.", basis: "sourced", source: "Press release (demo)" },
    { text: "Likely investing in an AI assistant roadmap, based on three open ML roles.", basis: "inference" },
    { text: "A pricing-tier redesign could lift self-serve conversion.", basis: "speculation" },
  ] },
  { id: "c2", name: "Harbor AI", domain: "harborai.example", researchedAt: null, findings: [] },
];

export const demoApplications: ApplicationView[] = [
  { id: "a1", jobId: "j2", title: "Founder's Office Intern", company: "Harbor AI", status: "succeeded", confirmed: true, evidence: "Confirmation page text: \"Thanks for applying\" (demo)", resume: "Founder's Office v3", relevance: 88, factualConfidence: 100, mode: "live", at: d(20) },
  { id: "a2", jobId: "j1", title: "Product Management Intern (MBA)", company: "Northwind Labs", status: "dry_run", confirmed: false, evidence: null, resume: "Product Management v2", relevance: 91, factualConfidence: 100, mode: "dry_run", at: d(2) },
  { id: "a3", jobId: "j3", title: "Product Marketing Manager Intern", company: "Lumen Retail", status: "unverified", confirmed: false, evidence: null, resume: "Product Marketing v1", relevance: 79, factualConfidence: 96, mode: "live", at: d(5) },
];

export const demoContacts: ContactView[] = [
  { id: "p1", name: "Riley Chen", title: "Director of Product", company: "Northwind Labs", relevance: 92, suppressed: false, suppressReason: null,
    sequence: [{ step: 1, status: "dry_run", when: d(2) }, { step: 2, status: "scheduled", when: new Date(Date.now() + 2 * 86400_000).toISOString() }] },
  { id: "p2", name: "Sam Okafor", title: "Recruiter", company: "Cobalt Systems", relevance: 74, suppressed: true, suppressReason: "Replied; sequence stopped",
    sequence: [{ step: 1, status: "sent", when: d(72) }, { step: 2, status: "stopped", when: null }] },
];

export const demoExceptions: ExceptionView[] = [
  { id: "e1", type: "sensitive_eligibility_question", detail: "Lumen Retail asks about visa sponsorship. Answer it yourself, then re-run.", entity: "Lumen Retail", createdAt: d(5), resolved: false },
  { id: "e2", type: "integration_not_connected", detail: "Gmail is not connected, so outreach stays in dry-run.", entity: "Gmail", createdAt: d(26), resolved: false },
  { id: "e3", type: "captcha", detail: "Cobalt Systems form showed a CAPTCHA. Complete it manually.", entity: "Cobalt Systems", createdAt: d(50), resolved: true },
];

export const demoProofs: ProofView[] = [
  { id: "w1", company: "Northwind Labs", title: "Self-serve conversion teardown", status: "preview_ready", previewUrl: null, loomScript: true },
  { id: "w2", company: "Cobalt Systems", title: "Mid-market GTM motion map", status: "draft", previewUrl: null, loomScript: false },
];

export const demoUpdates: UpdateView[] = [
  { id: "u1", kind: "interview", text: "Cobalt Systems asked for availability for a first-round call.", at: d(4) },
  { id: "u2", kind: "reply", text: "Sam Okafor replied. Follow-ups stopped.", at: d(6) },
  { id: "u3", kind: "deadline", text: "Northwind Labs application closes Nov 20.", at: d(1) },
];
