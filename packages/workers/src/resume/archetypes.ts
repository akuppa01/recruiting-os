import type { ResumeArchetype, RoleCategory } from "@ros/core";

export interface ArchetypeDef {
  id: ResumeArchetype; label: string; roleCategories: RoleCategory[];
  keywords: string[];          // JD keywords that pull toward this archetype
  priorityTags: string[];      // evidence tags that rank higher
  maxBullets: number;
}

export const ARCHETYPES: Record<ResumeArchetype, ArchetypeDef> = {
  product_management: {
    id: "product_management", label: "Product Management", roleCategories: ["product_management", "ai_strategy"],
    keywords: ["product", "roadmap", "user", "feature", "launch", "engineering", "backlog", "stakeholder", "metrics", "prototype", "technical", "ai"],
    priorityTags: ["product", "engineering", "ai", "roadmap", "technical", "launch"], maxBullets: 10,
  },
  product_marketing: {
    id: "product_marketing", label: "Product Marketing", roleCategories: ["product_marketing", "growth_brand"],
    keywords: ["positioning", "messaging", "launch", "go-to-market", "customer", "campaign", "brand", "content", "segmentation", "competitive", "enablement"],
    priorityTags: ["marketing", "positioning", "gtm", "content", "customer", "brand"], maxBullets: 10,
  },
  gtm_strategy: {
    id: "gtm_strategy", label: "GTM / Strategy", roleCategories: ["gtm_strategy", "bizops_corp_strategy", "strategic_partnerships", "vc_pe_search"],
    keywords: ["strategy", "market", "pricing", "sales", "revenue", "partnership", "analysis", "growth", "segment", "pipeline", "investment", "diligence"],
    priorityTags: ["gtm", "sales", "strategy", "revenue", "partnership", "analysis", "finance"], maxBullets: 10,
  },
  founders_office_bizops: {
    id: "founders_office_bizops", label: "Founder's Office / Business Operations", roleCategories: ["founders_office", "bizops_corp_strategy"],
    keywords: ["founder", "ceo", "operations", "startup", "cross-functional", "special projects", "process", "okr", "chief of staff", "scale", "0-1"],
    priorityTags: ["founder", "startup", "operations", "leadership", "entrepreneurship", "process"], maxBullets: 10,
  },
};

const words = (s: string) => s.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [];

/** Pick the best archetype: role category match dominates, keyword overlap breaks ties. */
export function selectArchetype(roleCategory: RoleCategory, jdText: string): { archetype: ResumeArchetype; scores: Record<string, number> } {
  const jd = jdText.toLowerCase();
  const scores: Record<string, number> = {};
  for (const a of Object.values(ARCHETYPES)) {
    const kw = a.keywords.filter((k) => jd.includes(k)).length;
    scores[a.id] = (a.roleCategories[0] === roleCategory ? 6 : a.roleCategories.includes(roleCategory) ? 4 : 0) + kw;
  }
  const best = (Object.entries(scores).sort((a, b) => b[1] - a[1])[0]![0]) as ResumeArchetype;
  return { archetype: best, scores };
}
export { words as _words };
