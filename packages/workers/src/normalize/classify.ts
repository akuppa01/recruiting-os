import type { RoleCategory } from "@ros/core";

const RULES: Array<[RoleCategory, RegExp]> = [
  ["product_marketing", /product marketing|\bpmm\b/i],
  ["product_management", /product manag|\bapm\b|\bproduct (intern|lead|owner)|\bpm intern|technical product/i],
  ["founders_office", /founder'?s? office|chief of staff|office of the (ceo|founder)/i],
  ["gtm_strategy", /go[- ]to[- ]market|\bgtm\b|revenue strategy|sales strategy|commercial strategy/i],
  ["ai_strategy", /ai strategy|ai (product )?(business|transformation)|\bai\b.*(strategy|solutions)|technical business|solutions strateg/i],
  ["strategic_partnerships", /partnership|business development|alliances/i],
  ["vc_pe_search", /venture capital|private equity|portfolio operations|search fund|\bvc\b|growth equity|investment (associate|analyst)/i],
  ["growth_brand", /growth (marketing|strategy|manag)|brand manag|brand marketing|marketing manag|consumer marketing/i],
  ["bizops_corp_strategy", /business operations|bizops|corporate strategy|strategy (&|and) operations|strategic finance|strategy intern|strategy associate|operations (strategy|manager)/i],
];

export function classifyRole(title: string, description = ""): RoleCategory {
  for (const [cat, re] of RULES) if (re.test(title)) return cat;
  const head = description.slice(0, 600);
  for (const [cat, re] of RULES) if (re.test(head)) return cat;
  return "other";
}
