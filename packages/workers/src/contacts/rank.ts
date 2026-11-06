import type { ContactCandidate, ContactTier, JobForRanking, RankedContact } from "./types.js";

/**
 * WEIGHTS (documented, additive, final score capped 0-100):
 *  tier base:   hiring_manager 60 > recruiter 48 > functional_leader 40 > peer 25 > other 5
 *  function match (title shares a keyword with the job's function): +10
 *  early-career/campus/university recruiter: +6
 *  warm signals (shared background): CMU/Tepper +14, UT Austin +10, Lockheed Martin +8
 *  has a usable email: +3 (deliverability only; never affects tier)
 * Warm signals come only from provider-supplied or user-supplied fields; nothing is scraped or guessed.
 */
export const WEIGHTS = {
  tier: { hiring_manager: 60, recruiter: 48, functional_leader: 40, peer: 25, other: 5 } as Record<ContactTier, number>,
  functionMatch: 10, earlyCareerRecruiter: 6, cmu: 14, utAustin: 10, lockheed: 8, email: 3,
};

const FUNCTION_KEYWORDS: Record<string, string[]> = {
  product_management: ["product"], product_marketing: ["product marketing", "pmm", "marketing"],
  gtm_strategy: ["go-to-market", "gtm", "strategy", "growth"], founders_office: ["chief of staff", "founder", "operations", "strategy"],
  bizops_corp_strategy: ["strategy", "operations", "bizops", "business operations", "corporate development"],
  growth_brand: ["growth", "brand", "marketing"], ai_strategy: ["ai", "machine learning", "data", "strategy"],
  strategic_partnerships: ["partnership", "alliances", "business development"], vc_pe_search: ["investment", "portfolio", "venture", "partner", "principal"],
};

function inferFunction(job: JobForRanking): string[] {
  if (job.roleCategory && FUNCTION_KEYWORDS[job.roleCategory]) return FUNCTION_KEYWORDS[job.roleCategory]!;
  const t = job.title.toLowerCase();
  for (const kws of Object.values(FUNCTION_KEYWORDS)) if (kws.some((k) => t.includes(k))) return kws;
  return [];
}

export function classifyTier(title: string | null, fn: string[]): ContactTier {
  const t = (title ?? "").toLowerCase();
  if (!t) return "other";
  if (/\b(recruit\w*|talent acquisition|sourcer|campus|university relations|people partner)\b/.test(t)) return "recruiter";
  const inFn = fn.length === 0 || fn.some((k) => t.includes(k));
  if (/hiring manager/.test(t)) return "hiring_manager";
  const senior = /\b(vp|vice president|head of|chief|cxo|c[a-z]o|svp|evp|director|president|founder|general manager)\b/.test(t);
  if (senior && inFn) return "functional_leader";
  if (inFn && /\b(associate|analyst|specialist|coordinator|intern)\b/.test(t)) return "peer";
  if (/\b(manager|lead|principal|group|staff)\b/.test(t) && inFn) return "hiring_manager";
  if (inFn && /\b(associate|analyst|specialist|senior|sr|product|strategist|operations|engineer|partner)\b/.test(t)) return "peer";
  return senior ? "functional_leader" : "other";
}

const has = (xs: string[] | undefined, re: RegExp) => !!xs?.some((x) => re.test(x));

export function rankContacts(contacts: ContactCandidate[], job: JobForRanking): RankedContact[] {
  const fn = inferFunction(job);
  const ranked = contacts.map((contact): RankedContact => {
    const tier = classifyTier(contact.title, fn);
    const reasons = [`tier=${tier}`];
    let score = WEIGHTS.tier[tier];
    const t = (contact.title ?? "").toLowerCase();
    if (fn.length && fn.some((k) => t.includes(k))) { score += WEIGHTS.functionMatch; reasons.push("function match"); }
    if (tier === "recruiter" && /(early career|campus|university|intern)/.test(t)) { score += WEIGHTS.earlyCareerRecruiter; reasons.push("early-career recruiter"); }
    if (has(contact.education, /carnegie mellon|tepper|\bcmu\b/i)) { score += WEIGHTS.cmu; reasons.push("warm: CMU/Tepper"); }
    if (has(contact.education, /university of texas|ut austin|\butexas\b/i)) { score += WEIGHTS.utAustin; reasons.push("warm: UT Austin"); }
    if (has(contact.pastEmployers, /lockheed/i)) { score += WEIGHTS.lockheed; reasons.push("warm: Lockheed Martin"); }
    if (contact.email) { score += WEIGHTS.email; reasons.push("email available"); }
    return { contact, score: Math.min(100, score), tier, reasons };
  });
  return ranked.sort((a, b) => b.score - a.score || a.contact.name.localeCompare(b.contact.name));
}
