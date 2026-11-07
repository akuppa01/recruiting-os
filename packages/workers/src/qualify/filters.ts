// Pure filters shared by discovery adapters and qualification. Target: Summer 2027 internships/fellowships.

export const INTERN = /\b(intern|interns|internship|fellow|fellowship|co-?op|summer associate)\b/i;

export type TargetRoleId =
  | "product_management" | "product_marketing" | "gtm_strategy" | "founders_office" | "business_operations"
  | "corporate_strategy" | "growth_strategy" | "brand_management" | "strategic_partnerships" | "ai_strategy"
  | "vc_pe_portfolio_ops" | "search_funds";

export interface TargetRole { id: TargetRoleId; label: string; strength: 100 | 80 }

const ROLE_RULES: Array<{ id: TargetRoleId; label: string; primary: RegExp; secondary?: RegExp }> = [
  { id: "product_management", label: "Product Management", primary: /product (management|manager)|\bapm\b/i },
  { id: "product_marketing", label: "Product Marketing", primary: /product marketing|\bpmm\b/i },
  { id: "gtm_strategy", label: "Go-to-Market Strategy", primary: /go[- ]to[- ]market|\bgtm\b/i },
  { id: "founders_office", label: "Founder's Office", primary: /founder'?s'? office|chief of staff|office of the (ceo|founder)/i },
  { id: "business_operations", label: "Business Operations", primary: /business operations|\bbizops\b|biz ?ops|strategy (&|and) (operations|ops)/i, secondary: /\boperations\b/i },
  { id: "corporate_strategy", label: "Corporate Strategy", primary: /corporate strategy|business strategy|strategic (planning|initiatives)/i, secondary: /\bstrategy\b|\bstrategic\b/i },
  { id: "growth_strategy", label: "Growth Strategy", primary: /growth (strategy|operations|product)/i, secondary: /\bgrowth\b/i },
  { id: "brand_management", label: "Brand Management", primary: /brand (management|manager|strategy)/i, secondary: /\bbrand\b/i },
  { id: "strategic_partnerships", label: "Strategic Partnerships", primary: /strategic partnerships?/i, secondary: /\bpartnerships?\b/i },
  { id: "ai_strategy", label: "AI Strategy", primary: /\bai\b.{0,20}(strategy|operations)|(strategy|operations).{0,20}\bai\b/i },
  { id: "vc_pe_portfolio_ops", label: "VC/PE Portfolio Operations", primary: /portfolio (operations|ops)|venture capital|private equity/i, secondary: /investment (analyst|associate)|\bventures?\b|\bvc\b|\bmba\b/i },
  { id: "search_funds", label: "Search Funds", primary: /search fund|\bsearcher\b|entrepreneurship through acquisition/i },
];

/** Best matching target role for a job title (primary phrase = 100, looser keyword = 80), or null. */
export function matchTargetRole(title: string): TargetRole | null {
  let best: TargetRole | null = null;
  for (const r of ROLE_RULES) {
    const strength: 100 | 80 | 0 = r.primary.test(title) ? 100 : r.secondary?.test(title) ? 80 : 0;
    if (strength && (!best || strength > best.strength)) best = { id: r.id, label: r.label, strength };
  }
  return best;
}

export const TITLE_EXCLUDE = /\b(engineer|engineering|developer|designer|design|counsel|legal|recruit|scientist|research|researcher|machine learning|software|data science|security|infrastructure|hardware|firmware|accountant|ux|ui)\b|technical (writer|support|recruiter|account)/i;

const MILITARY_TITLE = /nextstay|\bveterans?\b|military|service members?|skillbridge|transitioning service/i;
const MILITARY_DESC = /active[- ]duty service member|military transition|skillbridge/i;
export const isMilitaryTransition = (title: string, description = "") => MILITARY_TITLE.test(title) || MILITARY_DESC.test(description.slice(0, 1500));

const US_HIT = /(texas|\btx\b|austin|dallas|houston|san antonio|new york|\bnyc\b|\bny\b|california|\bca\b|san francisco|\bsf\b|bay area|los angeles|san jose|san mateo|palo alto|mountain view|menlo park|oakland|san diego|miami|florida|\bfl\b|united states|\busa\b|\bus\b|\bamer\b|north america)/i;
const REMOTE_HIT = /remote/i;
const FOREIGN_HIT = /(ireland|united kingdom|\buk\b|emea|canada|netherlands|germany|france|india|apac|australia|singapore|japan|brazil|mexico|europe|london|toronto|dublin|berlin|paris|argentina|latam)/i;

/** Target locations: Remote (not foreign-only), TX, NY, CA, FL, plus any extra preferred locations. */
export function locationOk(loc: string | null | undefined, extraPreferred: string[] = []): boolean {
  const l = loc ?? "";
  if (extraPreferred.some((e) => e && l.toLowerCase().includes(e.toLowerCase()))) return true;
  return US_HIT.test(l) || (REMOTE_HIT.test(l) && !FOREIGN_HIT.test(l));
}

/** Summer 2027 only: rejects postings naming another season/year without ever naming Summer 2027. */
export function seasonOk(text: string): boolean {
  if (/summer\s*(of\s*)?2027|2027\s*summer|summer\s*'27/i.test(text)) return true;
  const other = /(winter|fall|autumn|spring)\s*(of\s*)?20\d\d|summer\s*(of\s*)?20(2[0-6]|2[89])|\b20(25|26|28)\s*(summer|intern)/i.test(text);
  return !other;
}
export const statesSummer2027 = (text: string) => /summer\s*(of\s*)?2027|2027\s*summer|summer\s*'27/i.test(text);

/** Cheap pre-filter used by feed adapters before any detail fetch. */
export const titleMatches = (t: string) => INTERN.test(t) && matchTargetRole(t) !== null && !TITLE_EXCLUDE.test(t) && !MILITARY_TITLE.test(t);

export const TECH_WORDS = ["api", "apis", "developer", "developers", "platform", "saas", "ai", "machine learning", "llm", "data", "cloud", "infrastructure", "devtools", "technical", "sdk", "b2b", "engineering"];
export function techHits(text: string): string[] {
  const hay = text.toLowerCase();
  return TECH_WORDS.filter((w) => new RegExp(`\\b${w.replace(/ /g, "\\s+")}\\b`).test(hay));
}
