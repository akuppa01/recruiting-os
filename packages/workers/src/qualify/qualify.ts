// Pure qualification: hard rejects, transparent score, deadline-driven priority. No network, no model calls.
import type { NormalizedJob, Preferences } from "@ros/core";
import { INTERN, TITLE_EXCLUDE, isMilitaryTransition, locationOk, matchTargetRole, seasonOk, statesSummer2027, techHits } from "./filters.js";

export interface QualifyOptions { manual?: boolean }

export interface QualifyResult {
  decision: "qualify" | "archive" | "needs_review";
  score: number;                              // 0-100
  breakdown: { roleFit: number; location: number; season: number; tech: number; rankBonus: number };
  priority: number;                           // higher = process first (deadline-driven)
  targetRole: string | null;
  hardRejects: string[];
  reasons: string[];
}

const DAY = 86_400_000;

/** Deadline-driven priority band 0-100: sooner deadline = higher. No deadline = low-but-nonzero. */
export function deadlinePriority(deadline: string | null | undefined, now: Date = new Date()): number {
  if (!deadline) return 10;
  const t = Date.parse(`${deadline.slice(0, 10)}T23:59:59Z`);
  if (Number.isNaN(t)) return 10;
  const days = (t - now.getTime()) / DAY;
  if (days < 0) return 0;
  if (days <= 3) return 100;
  if (days <= 7) return 80;
  if (days <= 14) return 60;
  if (days <= 30) return 40;
  return 20;
}

export function isExpired(deadline: string | null | undefined, now: Date = new Date()): boolean {
  if (!deadline) return false;
  const t = Date.parse(`${deadline.slice(0, 10)}T23:59:59Z`);
  return !Number.isNaN(t) && t < now.getTime();
}

export function qualifyJob(n: NormalizedJob, prefs: Preferences, now: Date = new Date(), opts: QualifyOptions = {}): QualifyResult {
  const hardRejects: string[] = [];
  const reasons: string[] = [];
  const text = `${n.title}\n${n.description}`;

  // ---- hard filters (separate from weighted preferences)
  const isIntern = INTERN.test(n.title) || n.isInternship === true;
  if (n.isInternship === false && !INTERN.test(n.title)) hardRejects.push("not an internship or fellowship");
  else if (!isIntern) hardRejects.push("not an internship or fellowship");
  if (!seasonOk(text)) hardRejects.push("targets a season other than Summer 2027");
  if (n.eligibility.summer2027 === false) hardRejects.push("targets a season other than Summer 2027");
  if (isExpired(n.deadline, now)) hardRejects.push(`application deadline passed (${n.deadline})`);
  if (isMilitaryTransition(n.title, n.description)) hardRejects.push("military-transition program");
  if (TITLE_EXCLUDE.test(n.title)) hardRejects.push("engineering, design or research role");
  if (n.eligibility.mbaRequired === false) hardRejects.push("not open to MBA students");
  const co = n.company.toLowerCase();
  if (prefs.excludedCompanies.some((c) => c && co.includes(c.toLowerCase()))) hardRejects.push("excluded company");
  const loc = (n.location ?? "").toLowerCase();
  if (loc && prefs.locationsExcluded.some((l) => l && loc.includes(l.toLowerCase()))) hardRejects.push("excluded location");

  const locOk = locationOk(n.location, prefs.locationsPreferred) || n.remote === true;
  if (n.location && !locOk) hardRejects.push("outside target locations (Remote, TX, NY, CA, FL)");

  // pay (only when stated; values < 500 are treated as hourly, as elsewhere in the codebase)
  const pay = n.salaryMax ?? n.salaryMin;
  if (prefs.minHourlyUsd != null && pay != null && pay < 500 && pay < prefs.minHourlyUsd) hardRejects.push(`pay below minimum ($${pay}/hr)`);

  // ---- weighted score (only what is actually known; comp, company size and conversion are never invented)
  const role = matchTargetRole(n.title);
  const roleFit = role ? role.strength : opts.manual ? 40 : 0;
  const location = locOk ? 100 : n.location ? 40 : 60;
  const hits = n.description ? techHits(text) : [];
  const tech = n.description ? Math.min(100, hits.length * 12 + (/(technical|developer|platform|\bai\b|api)/i.test(n.title) ? 20 : 0)) : 0;
  const stated = statesSummer2027(text) || n.eligibility.summer2027 === true;
  const season = stated ? 100 : 50;
  const idx = prefs.roleOrder.indexOf(n.roleCategory);
  const rankBonus = idx >= 0 ? Math.max(0, 5 - idx) : 0;
  const score = Math.max(0, Math.min(100, Math.round(0.45 * roleFit + 0.2 * location + 0.2 * tech + 0.15 * season + rankBonus)));

  if (role) reasons.push(`Target role: ${role.label}`); else reasons.push("Title does not match a target role");
  reasons.push(locOk ? "Location is remote or in a target state" : n.location ? "Location outside target states" : "Location not stated");
  reasons.push(stated ? "Summer 2027 is stated" : "Season not stated in the posting (check before applying)");
  if (hits.length) reasons.push(`Technical signals: ${hits.slice(0, 5).join(", ")}`);
  if (n.deadline) reasons.push(`Deadline ${n.deadline}`);
  if (n.salaryMin) reasons.push(`Posted pay: ${n.salaryMin}${n.salaryMax && n.salaryMax !== n.salaryMin ? `-${n.salaryMax}` : ""} ${n.salaryCurrency ?? ""}`.trim());
  reasons.push("Compensation, company size and conversion were not assessed");

  let decision: QualifyResult["decision"];
  if (hardRejects.length) decision = "archive";
  else if (!role) decision = opts.manual ? "needs_review" : "archive";
  else if (!n.location) decision = "needs_review";
  else decision = score >= 55 ? "qualify" : "needs_review";
  if (hardRejects.length) reasons.unshift(`Rejected: ${[...new Set(hardRejects)].join("; ")}`);

  return {
    decision, score,
    breakdown: { roleFit, location, season, tech, rankBonus },
    priority: decision === "archive" ? 0 : deadlinePriority(n.deadline, now) + Math.floor(score / 20),
    targetRole: role?.label ?? null,
    hardRejects: [...new Set(hardRejects)],
    reasons,
  };
}
