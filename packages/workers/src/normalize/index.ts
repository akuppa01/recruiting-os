import { createHash } from "node:crypto";
import { NormalizedJob, type IngestRequest, type StructuredJobInput } from "@ros/core";
import { detectAts } from "./ats.js";
import { classifyRole } from "./classify.js";

export { detectAts } from "./ats.js";
export { classifyRole } from "./classify.js";

const SUFFIX = /\b(inc|llc|ltd|corp|corporation|co|company|gmbh|plc)\b\.?/g;
export const normToken = (s: string | null | undefined): string =>
  (s ?? "").toLowerCase().replace(SUFFIX, "").replace(/[^a-z0-9]+/g, " ").trim();

export function makeDedupeKey(o: { company: string; title: string; location?: string | null; atsKind?: string; atsJobId?: string | null; board?: string | null }): string {
  const basis = o.atsKind && o.atsKind !== "unknown" && o.atsJobId
    ? `ats|${o.atsKind}|${o.board ?? normToken(o.company)}|${o.atsJobId}`
    : `${normToken(o.company)}|${normToken(o.title)}|${normToken(o.location)}`;
  return createHash("sha256").update(basis).digest("hex");
}

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec";

export function extractSalary(text: string): { min: number | null; max: number | null; currency: string | null; hourly: boolean } {
  const re = /\$\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k)?\s?(?:-|–|—|to)\s?\$?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k)?\s?(\/\s?(?:hr|hour)|per hour|an hour|\/\s?(?:yr|year)|per year|annually)?/i;
  const m = text.match(re);
  if (m) {
    const n = (v: string, k?: string) => parseFloat(v.replace(/,/g, "")) * (k ? 1000 : 1);
    const hourly = !!m[5] && /hr|hour/i.test(m[5]);
    return { min: n(m[1]!, m[2]), max: n(m[3]!, m[4] ?? m[2]), currency: "USD", hourly };
  }
  const single = text.match(/\$\s?(\d{2,3}(?:\.\d+)?)\s?(?:\/\s?(?:hr|hour)|per hour|an hour)/i);
  if (single) { const v = parseFloat(single[1]!); return { min: v, max: v, currency: "USD", hourly: true }; }
  return { min: null, max: null, currency: null, hourly: false };
}

export function extractDeadline(text: string): string | null {
  const m = text.match(new RegExp(`(?:deadline|apply by|applications? (?:close|due)|closes?)[^\\n]{0,25}?((?:${MONTHS})[a-z]*\\.?\\s+\\d{1,2}(?:,?\\s+\\d{4})?|\\d{4}-\\d{2}-\\d{2})`, "i"));
  if (!m) return null;
  const d = new Date(/\d{4}/.test(m[1]!) ? m[1]! : `${m[1]} ${new Date().getFullYear()}`);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export interface TextExtract { title: string | null; company: string | null; location: string | null }

/** Heuristic header extraction from a pasted JD. Supports "Title at Company", "Company - Title", and labelled lines. */
export function extractFromText(text: string): TextExtract {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const labelled = (k: string) => lines.map((l) => l.match(new RegExp(`^(?:${k})\\s*[:\\-]\\s*(.+)$`, "i"))?.[1]).find(Boolean) ?? null;
  let title = labelled("(?:job )?title|role|position");
  let company = labelled("company|employer|organization");
  let location = labelled("location|office");
  const first = lines[0] ?? "";
  if (!title && first) {
    const at = first.match(/^(.{3,100}?)\s+(?:at|@)\s+(.{2,60})$/i);
    const dash = first.match(/^(.{2,60}?)\s+[-–—|]\s+(.{3,100})$/);
    if (at) { title = at[1]!; company ??= at[2]!; }
    else if (dash && /intern|manager|strategy|associate|analyst|product|marketing/i.test(dash[2]!)) { company ??= dash[1]!; title = dash[2]!; }
    else if (first.length < 120) title = first;
  }
  if (!location) {
    const lm = text.match(/\b(Remote|Hybrid|[A-Z][a-zA-Z .]+,\s?(?:[A-Z]{2}|[A-Z][a-z]+))\b/);
    location = lm?.[1] ?? null;
  }
  return { title, company, location };
}

export interface RawJobInput { url?: string; text?: string; job?: StructuredJobInput; fileText?: string }

export function rawFromRequest(req: IngestRequest): RawJobInput {
  return { url: req.url, text: req.text, job: req.job };
}

function companyFromUrl(url: string | null | undefined, board: string | null): string | null {
  if (board) return board.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  if (!url) return null;
  try {
    const h = new URL(url).hostname.replace(/^(www|careers|jobs)\./, "");
    return h.split(".")[0]!.replace(/\b\w/g, (c) => c.toUpperCase());
  } catch { return null; }
}

export function domainOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const h = new URL(url).hostname.replace(/^(www|careers|jobs)\./, "");
    return /greenhouse|lever|ashbyhq|myworkdayjobs|icims|smartrecruiters/.test(h) ? null : h;
  } catch { return null; }
}

/** Pure, offline normalization. Fields that cannot be determined stay null/unknown -- never guessed. */
export function normalizeJob(raw: RawJobInput): NormalizedJob {
  const s = raw.job;
  const text = [raw.text, raw.fileText, s?.description].filter(Boolean).join("\n");
  const url = s?.applyUrl ?? s?.sourceUrl ?? raw.url ?? null;
  const ats = detectAts(s?.applyUrl) .kind !== "unknown" ? detectAts(s?.applyUrl) : detectAts(url);
  const ex = text ? extractFromText(raw.text ?? raw.fileText ?? "") : { title: null, company: null, location: null };
  const title = s?.title ?? ex.title ?? "Untitled role";
  const company = s?.company ?? ex.company ?? companyFromUrl(url, ats.board) ?? "Unknown company";
  const location = s?.location ?? ex.location ?? null;
  const sal = extractSalary(text);
  // Hourly figures are annualised only for comparison elsewhere; store as given with currency.
  const lower = `${title}\n${text}`.toLowerCase();
  const isInternship = /intern(ship)?\b/.test(title.toLowerCase()) ? true : /\binternship\b|summer intern/.test(lower) ? true : text ? false : null;
  // true = MBA mentioned; false = explicitly undergrad/PhD-only (ineligible for an MBA student); null = unknown
  const mbaRequired = /\bmba\b|master of business administration/.test(lower) ? true
    : /(undergraduate|bachelor'?s?)\s+(students?|degree|candidates?|only)|currently (pursuing|enrolled)[^.\n]{0,40}(bachelor|undergraduate)|\bphd (students?|candidates?)\b/.test(lower) ? false : null;
  const summer2027 = /summer\s*(of\s*)?2027|2027\s*summer|\bsummer '27\b/.test(lower) ? true : /summer\s*(of\s*)?20(2[0-6]|2[89])/.test(lower) ? false : null;
  const workAuth = text.match(/[^.\n]*(sponsor|work authorization|authorized to work|citizen)[^.\n]*/i)?.[0]?.trim() ?? null;
  const remote = /\bremote\b/i.test(`${location ?? ""} ${text.slice(0, 800)}`) ? true : location ? false : null;
  const deadline = s?.deadline ?? extractDeadline(text);
  return NormalizedJob.parse({
    title: title.trim(),
    company: company.trim(),
    companyDomain: domainOf(url) ?? domainOf(s?.sourceUrl),
    location,
    remote,
    description: text,
    applyUrl: s?.applyUrl ?? (raw.url ?? null),
    sourceUrl: s?.sourceUrl ?? raw.url ?? null,
    atsKind: ats.kind,
    atsJobId: ats.jobId,
    salaryMin: s?.salaryMin ?? sal.min,
    salaryMax: s?.salaryMax ?? sal.max,
    salaryCurrency: s?.salaryCurrency ?? sal.currency,
    deadline,
    roleCategory: classifyRole(title, text),
    isInternship,
    eligibility: { mbaRequired, workAuthNotes: workAuth, summer2027 },
    dedupeKey: makeDedupeKey({ company, title, location, atsKind: ats.kind, atsJobId: ats.jobId, board: ats.board }),
  });
}
