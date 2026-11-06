import type { EvidenceItem, NormalizedJob, ResumeArchetype } from "@ros/core";
import { ARCHETYPES, selectArchetype } from "./archetypes.js";
import type { CandidateProfile } from "./evidence.js";
import { verifyBullet, verifyResume, type ResumeContent, type ResumeSection } from "./verify.js";

const wordsOf = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9][a-z0-9-]+/g) ?? []).filter((w) => w.length > 2));

export interface TailorResult {
  archetype: ResumeArchetype; contentJson: ResumeContent; relevanceScore: number; factualConfidence: number;
  selectedEvidenceIds: string[]; verification: ReturnType<typeof verifyResume>;
}

export interface TailorOpts { profile?: CandidateProfile | null; maxPerEmployer?: number; maxBullets?: number }

/**
 * Selects and reorders VERBATIM verified statements. Never adds text. Employer order follows evidence order (treated as most-recent-first).
 * Throws if the evidence bank is empty (callers raise an exception task).
 */
export function tailorResume(job: NormalizedJob, evidence: EvidenceItem[], archetypeIn?: ResumeArchetype, opts: TailorOpts = {}): TailorResult {
  if (!evidence.length) throw new Error("evidence bank is empty; supply verified evidence (resumes/evidence/README.md)");
  const jdText = `${job.title}\n${job.description}`;
  const archetype = archetypeIn ?? selectArchetype(job.roleCategory, jdText).archetype;
  const def = ARCHETYPES[archetype];
  const jd = wordsOf(jdText);
  const max = opts.maxBullets ?? def.maxBullets, perEmp = opts.maxPerEmployer ?? 4;

  const scored = evidence.map((e, order) => {
    const ew = wordsOf(`${e.statement} ${e.tags.join(" ")}`);
    let overlap = 0; for (const w of ew) if (jd.has(w)) overlap++;
    const tagBonus = e.tags.filter((t) => def.priorityTags.includes(t.toLowerCase())).length * 2;
    const metricBonus = e.metrics.length ? 1 : 0;
    return { e, order, rel: overlap + tagBonus + metricBonus };
  }).sort((a, b) => b.rel - a.rel || a.order - b.order);

  const picked: typeof scored = [];
  const perCount = new Map<string, number>();
  for (const s of scored) {
    if (picked.length >= max) break;
    const k = `${s.e.employer}|${s.e.role}`;
    if ((perCount.get(k) ?? 0) >= perEmp) continue;
    picked.push(s); perCount.set(k, (perCount.get(k) ?? 0) + 1);
  }
  // group by employer/role in evidence order; bullets within by relevance
  const groups = new Map<string, { first: number; items: typeof picked }>();
  for (const p of picked) {
    const k = `${p.e.employer}|${p.e.role}|${p.e.dates}`;
    const g = groups.get(k) ?? { first: p.order, items: [] };
    g.first = Math.min(g.first, p.order); g.items.push(p); groups.set(k, g);
  }
  const sections: ResumeSection[] = [...groups.values()].sort((a, b) => a.first - b.first).map((g) => ({
    employer: g.items[0]!.e.employer, role: g.items[0]!.e.role, dates: g.items[0]!.e.dates,
    bullets: g.items.sort((a, b) => b.rel - a.rel).map((p) => ({ evidenceId: p.e.id, text: p.e.statement, rephrased: false })),
  }));

  const profile = opts.profile;
  const contentJson: ResumeContent = {
    archetype, headline: def.label,
    name: profile?.name ?? "", contact: [profile?.email, profile?.phone, profile?.linkedin, profile?.location].filter(Boolean) as string[],
    education: profile?.education ?? [], sections,
  };
  const verification = verifyResume(contentJson, evidence);
  const total = picked.length || 1;
  const maxRel = Math.max(1, ...picked.map((p) => p.rel));
  const relevanceScore = Math.round((picked.reduce((a, p) => a + Math.min(1, p.rel / Math.max(6, maxRel)), 0) / total) * 1000) / 10;
  const failed = new Set(verification.failures.map((f) => f.evidenceId));
  const factualConfidence = Math.round(((picked.filter((p) => !failed.has(p.e.id)).length) / total) * 1000) / 1000;
  return { archetype, contentJson, relevanceScore, factualConfidence, selectedEvidenceIds: picked.map((p) => p.e.id), verification };
}

/**
 * Optional LLM polish. `rewrite` proposes new wording for a bullet; each proposal must pass verifyBullet or the verbatim text is kept.
 */
export async function rephraseBullets(
  result: TailorResult, evidence: EvidenceItem[], job: NormalizedJob,
  rewrite: (statement: string, job: NormalizedJob) => Promise<string | null>,
): Promise<{ result: TailorResult; accepted: number; rejected: number }> {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  let accepted = 0, rejected = 0;
  for (const s of result.contentJson.sections) for (const b of s.bullets) {
    const src = byId.get(b.evidenceId)!;
    const cand = (await rewrite(src.statement, job))?.trim();
    if (!cand || cand === src.statement) continue;
    if (verifyBullet(cand, src).ok) { b.text = cand; b.rephrased = true; accepted++; } else rejected++;
  }
  result.verification = verifyResume(result.contentJson, evidence);
  return { result, accepted, rejected };
}
