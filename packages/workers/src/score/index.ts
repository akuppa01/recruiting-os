import { ScoreBreakdown, Preferences, type NormalizedJob, type RoleCategory } from "@ros/core";

const PREMIUM = /\b(google|meta|amazon|microsoft|apple|stripe|openai|anthropic|nvidia|salesforce|adobe|uber|airbnb|databricks|snowflake|figma|notion|ramp|datadog|mckinsey|bain|bcg|blackstone|kkr)\b/i;
const CONV = /(return offer|full[- ]time (conversion|offer|opportunit)|convert(ed)? to full|conversion)/i;
const FLEX = /(flexible|hybrid|remote|work[- ]life|reasonable hours)/i;
const LONGHOURS = /(60\+ hours|70[- ]hour|80[- ]hour|banking hours|120 hours)/i;
const RESP = /(own(ership)?|lead|drive|strategic|roadmap|cross-functional|launch|p&l|end[- ]to[- ]end)/gi;
const ENTREP = /(startup|early[- ]stage|founder|0-1|zero to one|entrepreneur|venture)/i;

const clamp = (n: number) => Math.max(0, Math.min(100, n));

/** Convert stored salary (hourly if < 500) to a rough hourly USD figure. */
export function hourlyUsd(job: NormalizedJob): number | null {
  const v = job.salaryMax ?? job.salaryMin;
  if (v == null) return null;
  if (job.salaryCurrency && job.salaryCurrency !== "USD") return null;
  return v < 500 ? v : v / 2080;
}

export function scoreJob(job: NormalizedJob, prefsIn: Partial<Preferences> = {}): ScoreBreakdown {
  const prefs = Preferences.parse(prefsIn);
  const text = `${job.title}\n${job.description}`;
  const hardRejects: string[] = [];

  if (job.isInternship === false) hardRejects.push("not an internship");
  if (job.eligibility.summer2027 === false) hardRejects.push("targets a season other than Summer 2027");
  if (job.eligibility.mbaRequired === false) hardRejects.push("not open to MBA students");
  const co = job.company.toLowerCase();
  if (prefs.excludedCompanies.some((c) => c && co.includes(c.toLowerCase()))) hardRejects.push("excluded company");
  const loc = (job.location ?? "").toLowerCase();
  if (loc && prefs.locationsExcluded.some((l) => l && loc.includes(l.toLowerCase()))) hardRejects.push("excluded location");
  const hr = hourlyUsd(job);
  if (prefs.minHourlyUsd != null && hr != null && hr < prefs.minHourlyUsd) hardRejects.push(`pay below minimum ($${hr.toFixed(0)}/hr)`);

  // role fit: earlier in roleOrder scores higher; other = low
  const order = prefs.roleOrder as RoleCategory[];
  const idx = order.indexOf(job.roleCategory);
  const roleFit = idx < 0 ? 15 : clamp(100 - idx * (60 / Math.max(1, order.length - 1)));
  const comp = hr == null ? 50 : clamp((hr / 70) * 100);
  const conversion = CONV.test(text) ? 85 : job.isInternship ? 50 : 30;
  const respHits = (text.match(RESP) ?? []).length;
  const responsibility = clamp(35 + respHits * 8);
  let flexibility = FLEX.test(text) || job.remote ? 75 : 50;
  if (LONGHOURS.test(text)) flexibility = 10;
  const upside = PREMIUM.test(job.company) ? 90 : 55;
  const entrepreneurialCompat = ENTREP.test(text) ? 80 : 50;
  if (prefs.locationsPreferred.length && loc && !prefs.locationsPreferred.some((l) => loc.includes(l.toLowerCase())) && !job.remote) {
    flexibility = Math.min(flexibility, 40);
  }

  const w = prefs.weights;
  const wsum = w.roleFit + w.comp + w.conversion + w.responsibility + w.flexibility + w.upside + w.entrepreneurialCompat;
  const total = clamp(
    (roleFit * w.roleFit + comp * w.comp + conversion * w.conversion + responsibility * w.responsibility +
      flexibility * w.flexibility + upside * w.upside + entrepreneurialCompat * w.entrepreneurialCompat) / wsum,
  );

  let decision: ScoreBreakdown["decision"];
  if (hardRejects.length) decision = "archive";
  else if (job.roleCategory === "other") decision = total >= prefs.policy.minScoreToApply + 10 ? "needs_review" : "archive";
  else if (job.isInternship == null) decision = total >= prefs.policy.minScoreToApply - 10 ? "needs_review" : "archive"; // unknown nature: never auto-qualify
  else decision = total >= prefs.policy.minScoreToApply ? "qualify" : total >= prefs.policy.minScoreToApply - 10 ? "needs_review" : "archive";

  const r = (n: number) => Math.round(n * 10) / 10;
  const rationale = hardRejects.length
    ? `Rejected: ${hardRejects.join("; ")}.`
    : `Role ${job.roleCategory} (fit ${r(roleFit)}), comp ${hr == null ? "unknown" : "$" + hr.toFixed(0) + "/hr"}, conversion ${r(conversion)}; total ${r(total)} -> ${decision}.`;
  return ScoreBreakdown.parse({
    total: r(total), roleFit: r(roleFit), comp: r(comp), conversion: r(conversion), responsibility: r(responsibility),
    flexibility: r(flexibility), upside: r(upside), entrepreneurialCompat: r(entrepreneurialCompat), hardRejects, rationale, decision,
  });
}
