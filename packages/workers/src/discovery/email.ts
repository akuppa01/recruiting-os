// Saved-search / job-alert emails (Handshake, 12twenty, LinkedIn, Indeed) via an injected Gmail connector.
// Official alerts only: no authenticated scraping. When Gmail isn't connected the adapter reports notConfigured (never fake data).
import { createHash } from "node:crypto";
import type { DiscoveredJob, SourceAdapter, SourceRunResult, StructuredJobInput } from "@ros/core";
import { parseAlertEmail, type EmailLike } from "../gmail/alerts.js";
import type { GmailResult } from "../gmail/connector.js";
import { canonicalizeUrl } from "./url.js";
import { errMsg } from "./util.js";

export type EmailSourceId = "handshake" | "twelve_twenty" | "linkedin_alert" | "indeed_alert";

/** Optional hook that turns a tracking/redirect link into the real posting URL. Return null when it cannot be resolved. */
export type ResolveUrl = (url: string) => Promise<string | null>;

export interface EmailAdapterOptions {
  getGmail: () => GmailResult | Promise<GmailResult>;
  query?: string; max?: number;
  /** Resolves 12twenty click-tracking links. Never required: unresolved links are kept as-is and flagged needsEnrichment. */
  resolveUrl?: ResolveUrl;
  /** Upper bound on resolveUrl calls per run (default 40) so a big digest cannot trigger a request storm. */
  maxResolve?: number;
}

export const DEFAULT_ALERT_QUERY: Record<EmailSourceId, string> = {
  handshake: "from:joinhandshake.com newer_than:14d",
  twelve_twenty: "from:12twenty newer_than:14d",
  linkedin_alert: "from:linkedin.com (subject:job OR subject:jobs) newer_than:14d",
  indeed_alert: "from:indeed.com (subject:job OR subject:jobs OR subject:alert) newer_than:14d",
};

const SENDER: Record<EmailSourceId, RegExp> = {
  handshake: /joinhandshake\.com/i, twelve_twenty: /12twenty/i, linkedin_alert: /linkedin\.com/i, indeed_alert: /indeed\.com/i,
};

// Lines that carry school/program-specific eligibility or application rules. Preserved verbatim (Handshake / 12twenty).
const REQUIREMENT_LINE = /(eligib|requirement|must be|currently enrolled|class of|graduat|work authori|gpa|major\b|degree|students? (only|must)|open to|citizen|visa|sponsor)/i;
export function extractSchoolRequirements(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 12 && l.length <= 400 && !/^https?:\/\/\S+$/.test(l) && REQUIREMENT_LINE.test(l));
  return lines.length ? [...new Set(lines)].slice(0, 12).join("\n") : undefined;
}

// ---- Indeed (not covered by gmail/alerts.ts)
const INDEED_URL = /https?:\/\/[^\s<>")\]]*indeed\.com\/(?:viewjob|rc\/clk|m\/viewjob|pagead\/clk)[^\s<>")\]]*/gi;
const NOISE = /^(view job|apply now|apply|view|see all|unsubscribe|manage|new jobs?|jobs? (?:alert|for you)|easily apply|urgently hiring|\d+ new jobs?|indeed|sponsored)\b/i;
const splitCompanyLoc = (line: string): { company: string; location?: string } => {
  const parts = line.split(/\s+[-–·•|]\s+/).map((s) => s.trim()).filter(Boolean);
  return { company: parts[0] ?? line.trim(), location: parts[1] };
};

export interface AlertJob {
  url?: string; title?: string; company?: string; location?: string;
  jobType?: string; deadline?: string; salaryMin?: number; salaryMax?: number;
}

export function parseIndeedEmail(email: EmailLike): AlertJob[] {
  const lines = email.text.split(/\r?\n/).map((l) => l.trim());
  const out: AlertJob[] = []; const seen = new Set<string>();
  lines.forEach((line, i) => {
    for (const raw of line.match(INDEED_URL) ?? []) {
      const url = canonicalizeUrl(raw);
      if (!/jk=/.test(url)) continue;                       // wrapped/ad-click links can't be resolved without a network hop
      if (seen.has(url)) continue; seen.add(url);
      const prev: string[] = [];
      for (let j = i - 1; j >= 0 && prev.length < 3; j--) {
        const l = lines[j]!;
        if (!l || NOISE.test(l) || /^https?:\/\//.test(l)) { if (prev.length) break; continue; }
        prev.unshift(l);
      }
      const job: AlertJob = { url };
      if (prev.length >= 3) { job.title = prev[prev.length - 3]; job.company = prev[prev.length - 2]; job.location = prev[prev.length - 1]; }
      else if (prev.length === 2) { job.title = prev[0]; Object.assign(job, splitCompanyLoc(prev[1]!)); }
      else if (prev.length === 1) job.title = prev[0];
      out.push(job);
    }
  });
  return out;
}

// ---------------------------------------------------------------- shared helpers for the real alert layouts
const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const iso = (y: number, m: number, d: number) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** "Application Deadline: Sunday, 29 November 2026 11:59PM EST" -> "2026-11-29". Also "November 29, 2026". */
export function parseDeadline(line: string): string | undefined {
  const a = line.match(/(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/);
  if (a) { const m = MONTHS[a[2]!.toLowerCase()]; if (m) return iso(Number(a[3]), m, Number(a[1])); }
  const b = line.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (b) { const m = MONTHS[b[1]!.toLowerCase()]; if (m) return iso(Number(b[3]), m, Number(b[2])); }
  return undefined;
}

/** "Oliver Wyman - Oliver Wyman - MBA Summer Associate 2027" -> company "Oliver Wyman", title "MBA Summer Associate 2027". */
export function splitCompanyTitle(raw: string): { company?: string; title: string } {
  const s = raw.replace(/\s+/g, " ").trim();
  const i = s.indexOf(" - ");
  if (i <= 0) return { title: s };
  const company = s.slice(0, i).trim();
  let title = s.slice(i + 3).trim();
  if (title.toLowerCase().startsWith(`${company.toLowerCase()} - `)) title = title.slice(company.length + 3).trim();
  return { company, title: title || s };
}

const TYPE_LINE = /^(internship|job listing|full[- ]?time|part[- ]?time|co-?op|fellowship|experiential|volunteer|contract|temporary|seasonal)\b[\w ,/&-]{0,70}$/i;
const DEADLINE_LINE = /^application deadline\b/i;
const URL_ONLY = /^\[?<?\s*https?:\/\/\S*$/;
const CLICK_LINK = /^\[?<?\s*(https?:\/\/click\.12twenty\.com\/[^\s<>\])]*)/i;
const DIGEST_HEADER = /^NEW JOB POSTINGS\b/i;

/** Hosts whose URLs are applyable postings the pipeline can read directly. */
export const isAtsUrl = (u: string) => /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com)$/i.test(hostOf(u));
const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return ""; } };
const isTracking = (u: string) => /(^|\.)click\.12twenty\.com$/i.test(hostOf(u));
const short = (s: string) => createHash("sha1").update(s.toLowerCase()).digest("hex").slice(0, 16);

// ---------------------------------------------------------------- 12twenty
/**
 * 12twenty saved-search digests and "new job opportunity" mails list jobs as repeated blocks:
 *   Company - [Company - ]Title (the title may wrap onto the next line)
 *   [<click.12twenty.com tracking link>],
 *   Internship, Job Listing
 *   Application Deadline: Sunday, 29 November 2026 11:59PM EST
 * Events/invites contain no such blocks and yield nothing.
 */
export function parseTwelveTwentyEmail(email: EmailLike): AlertJob[] {
  const lines = email.text.split(/\r?\n/).map((l) => l.trim());
  const digest = /^saved search\b/i.test(email.subject) || lines.some((l) => DIGEST_HEADER.test(l));
  const out: AlertJob[] = []; const seen = new Set<string>();
  lines.forEach((line, i) => {
    const link = line.match(CLICK_LINK);
    if (!link) return;
    // title lines directly above the link (no blank line between), at most three wrapped lines
    const above: string[] = [];
    for (let j = i - 1; j >= 0 && above.length < 3; j--) {
      const l = lines[j]!;
      if (!l || URL_ONLY.test(l) || TYPE_LINE.test(l) || DEADLINE_LINE.test(l) || DIGEST_HEADER.test(l)) break;
      above.unshift(l);
    }
    if (!above.length) return;
    // details directly below the link
    let jobType: string | undefined; let deadline: string | undefined; let sawDetail = false;
    for (let k = i + 1, n = 0; k < lines.length && n < 4; k++) {
      const l = lines[k]!;
      if (!l) { if (sawDetail) break; continue; }
      n++;
      if (DEADLINE_LINE.test(l)) { deadline = parseDeadline(l); sawDetail = true; }
      else if (TYPE_LINE.test(l)) { jobType = l; sawDetail = true; }
      else break;
    }
    const { company, title } = splitCompanyTitle(above.join(" "));
    // Digests can be cut off mid-block; a "Company - Title" line plus a click link still counts there.
    if (!sawDetail && !(digest && company)) return;
    const key = `${company ?? ""}|${title}|${deadline ?? ""}`.toLowerCase();
    if (seen.has(key)) return; seen.add(key);
    out.push({ url: link[1]!, company, title, jobType, deadline });
  });
  return out;
}

// ---------------------------------------------------------------- Handshake weekly jobs round-up
// The plain-text round-up has NO links: blocks of "Company / Title / [Promoted • ][$pay • ]Type • Location".
const HS_DETAIL = /^(?:promoted\s*•\s*)?(?:(\$[^•]+?)\s*•\s*)?(full-time|part-time|internship|co-?op|contract|temporary|fellowship|seasonal|volunteer|on-campus)\s*•\s*(.+)$/i;

function parsePay(pay: string): { min?: number; max?: number } {
  const m = pay.match(/\$\s*([\d,.]+)\s*(k)?\s*(?:[–-]\s*\$?\s*([\d,.]+)\s*(k)?)?\s*\/\s*(yr|year|hr|hour)/i);
  if (!m) return {};
  const num = (v: string, k?: string) => parseFloat(v.replace(/,/g, "")) * (k ? 1000 : 1);
  const k2 = m[4] ?? m[2];                                    // "$155–200K" scales both ends
  const min = num(m[1]!, m[2] ?? (m[3] ? k2 : undefined));
  const max = m[3] ? num(m[3], k2) : undefined;
  return { min, max: max ?? min };
}

export function parseHandshakeRoundup(email: EmailLike): AlertJob[] {
  const ne = email.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: AlertJob[] = []; const seen = new Set<string>();
  ne.forEach((line, k) => {
    const m = line.match(HS_DETAIL);
    if (!m || k < 2) return;
    const title = ne[k - 1]!; const company = ne[k - 2]!;
    if (HS_DETAIL.test(title) || HS_DETAIL.test(company) || company.length > 120 || title.length > 220) return;
    let location = m[3]!.trim().replace(/\s*\((?:onsite|on-site|hybrid|remote)\)\s*$/i, "").replace(/\s*\+\d+\s*$/, "").trim();
    if (/^remote\b/i.test(m[3]!)) location = "Remote";
    const pay = m[1] ? parsePay(m[1]) : {};
    const key = `${company}|${title}|${location}`.toLowerCase();
    if (seen.has(key)) return; seen.add(key);
    out.push({ company, title, location: location || undefined, jobType: m[2]!, salaryMin: pay.min, salaryMax: pay.max });
  });
  return out;
}

// ---------------------------------------------------------------- redirect resolver (optional, injected by the caller)
/** Follows redirects without downloading bodies. Returns the final URL, or null on error/timeout. */
export async function followRedirects(url: string, o: { timeoutMs?: number; maxHops?: number; fetchImpl?: typeof fetch } = {}): Promise<string | null> {
  const f = o.fetchImpl ?? fetch;
  let cur = url;
  try {
    for (let hop = 0; hop < (o.maxHops ?? 5); hop++) {
      const res = await f(cur, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(o.timeoutMs ?? 5000), headers: { "user-agent": "Mozilla/5.0 (compatible; RecruitingOS/1.0)" } });
      const loc = res.headers.get("location");
      try { await res.body?.cancel(); } catch { /* body already consumed or absent */ }
      if (res.status >= 300 && res.status < 400 && loc) { cur = new URL(loc, cur).toString(); continue; }
      return cur;
    }
    return cur;
  } catch { return null; }
}

// ---------------------------------------------------------------- adapter
const redactGreeting = (subject: string) => subject.replace(/^[A-Z][\w'’-]+,\s+/, "");

export function createEmailAdapter(id: EmailSourceId, o: EmailAdapterOptions): SourceAdapter {
  return {
    id, kind: "email",
    async run(_ctx, opts): Promise<SourceRunResult> {
      let g: GmailResult;
      try { g = await o.getGmail(); } catch (e) { return { source: id, jobs: [], error: `gmail unavailable: ${errMsg(e)}` }; }
      if (!g.connected) return { source: id, jobs: [], notConfigured: `Gmail not connected: ${g.reason}` };

      let emails: Array<EmailLike & { threadId?: string }>;
      try { emails = await g.listRecent(o.query ?? DEFAULT_ALERT_QUERY[id], o.max ?? 25); }
      catch (e) { return { source: id, jobs: [], error: `gmail listRecent failed: ${errMsg(e)}` }; }

      const since = opts?.since ? Date.parse(opts.since) : NaN;
      const jobs: DiscoveredJob[] = [];
      const seenKeys = new Set<string>();                       // the same job repeats across daily digests
      let resolveBudget = o.maxResolve ?? 40;

      for (const email of emails) {
        if (!SENDER[id].test(email.from)) continue;
        if (!Number.isNaN(since) && email.date && Date.parse(email.date) < since) continue;
        const school = id === "handshake" || id === "twelve_twenty" ? extractSchoolRequirements(email.text) : undefined;
        const evidenceBase = { kind: "email" as const, receivedAt: email.date };

        // Real layouts first (12twenty blocks, Handshake round-up); otherwise the link-anchored parsers.
        const blocks: AlertJob[] = id === "twelve_twenty" ? parseTwelveTwentyEmail(email) : id === "handshake" ? parseHandshakeRoundup(email) : [];
        for (const j of blocks) {
          const company = j.company; const title = j.title ?? "Untitled role";
          const key = `${id}|${company ?? ""}|${title}|${j.deadline ?? ""}|${j.location ?? ""}`.toLowerCase();
          if (seenKeys.has(key)) continue; seenKeys.add(key);

          let applyUrl = j.url; let canonical: string | null = null; let needsEnrichment = false;
          if (j.url) {
            if (isTracking(j.url)) {
              needsEnrichment = true;
              if (o.resolveUrl && resolveBudget > 0) {
                resolveBudget--;
                let r: string | null = null;
                try { r = await o.resolveUrl(j.url); } catch { r = null; }
                if (r && r !== j.url && !isTracking(r)) { applyUrl = r; canonical = canonicalizeUrl(r); needsEnrichment = !isAtsUrl(r); }
              }
              // Unresolved tracking links all canonicalize to the same URL, so they must not be used as identity.
            } else { canonical = canonicalizeUrl(j.url); }
          }
          const desc = [
            j.jobType ? `Job type: ${j.jobType}.` : "",
            j.location ? `Location: ${j.location}.` : "",
            j.deadline ? `Application deadline: ${j.deadline}.` : "",
            id === "twelve_twenty" ? "Found in a 12twenty saved-search email (school job board)." : "Found in a Handshake weekly jobs round-up email.",
          ].filter(Boolean).join(" ");
          const job: StructuredJobInput = {
            title, company: company ?? "Unknown company", location: j.location, description: desc,
            ...(applyUrl ? { applyUrl, sourceUrl: applyUrl } : {}),
            ...(j.deadline ? { deadline: j.deadline } : {}),
            ...(j.salaryMin ? { salaryMin: j.salaryMin, salaryMax: j.salaryMax ?? j.salaryMin, salaryCurrency: "USD" } : {}),
          };
          jobs.push({
            source: id, sourceRef: `${id}:${short(key)}`, canonicalUrl: canonical, job,
            evidence: { ...evidenceBase, excerpt: redactGreeting(email.subject) },
            ...(school ? { schoolRequirements: school } : {}),
            ...(needsEnrichment ? { needsEnrichment: true } : {}),
          });
        }
        if (blocks.length) continue;

        const parsed: AlertJob[] = id === "indeed_alert" ? parseIndeedEmail(email) : parseAlertEmail(email).filter((j) => j.source === id);
        for (const j of parsed) {
          if (!j.url) continue;
          const resolved = !!(j.title && j.company);
          jobs.push({
            source: id, sourceRef: email.messageId ?? `${email.from}:${email.subject}:${j.url}`,
            canonicalUrl: canonicalizeUrl(j.url),
            // Placeholders title/company mean "needs URL enrichment downstream"; the original URL and email are kept as evidence.
            job: { title: j.title ?? "Untitled role", company: j.company ?? "Unknown company", location: j.location, applyUrl: j.url, sourceUrl: j.url },
            evidence: { ...evidenceBase, excerpt: resolved ? redactGreeting(email.subject) : `${redactGreeting(email.subject)} [title/company unresolved]` },
            ...(school ? { schoolRequirements: school } : {}),
            ...(resolved ? {} : { needsEnrichment: true }),
          });
        }
      }
      return { source: id, jobs: opts?.limit ? jobs.slice(0, opts.limit) : jobs };
    },
  };
}
