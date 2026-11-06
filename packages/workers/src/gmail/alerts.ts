// Parse job-alert emails (LinkedIn / Handshake / 12twenty / ATS-style) into ingestable jobs. Heuristic, fixture-tested.
import type { IngestRequest, IngestSource, StructuredJobInput } from "@ros/core";

export interface EmailLike { from: string; subject: string; text: string; date?: string; messageId?: string }
export interface ParsedAlertJob { source: IngestSource; url: string; title?: string; company?: string; location?: string }

const JOB_URL = /https?:\/\/[^\s<>")\]]+/g;
const JOB_PATTERNS: Array<[RegExp, IngestSource]> = [
  [/linkedin\.com\/(?:comm\/)?jobs\/view\/\d+/i, "linkedin_alert"],
  [/joinhandshake\.com\/(?:stu\/)?jobs\/\d+/i, "handshake"],
  [/12twenty\.com\/[^\s]*(?:job|posting)/i, "twelve_twenty"],
  [/(?:boards|job-boards)\.greenhouse\.io\/[^/\s]+\/jobs\/\d+|jobs\.lever\.co\/[^/\s]+\/[0-9a-f-]{8,}|jobs\.ashbyhq\.com\/[^/\s]+\/[0-9a-f-]{8,}/i, "ats_feed"],
];

export function senderSource(from: string): IngestSource | null {
  const f = from.toLowerCase();
  if (f.includes("linkedin.com")) return "linkedin_alert";
  if (f.includes("joinhandshake.com")) return "handshake";
  if (f.includes("12twenty")) return "twelve_twenty";
  if (/greenhouse|lever\.co|ashbyhq/.test(f)) return "ats_feed";
  return null;
}

/** Strip tracking params; keep a canonical job URL. */
export function cleanJobUrl(u: string): string {
  const url = u.replace(/[.,;)]+$/, "");
  const m = url.match(/linkedin\.com\/(?:comm\/)?jobs\/view\/(\d+)/i);
  if (m) return `https://www.linkedin.com/jobs/view/${m[1]}`;
  try { const x = new URL(url); x.search = ""; x.hash = ""; return x.toString(); } catch { return url; }
}

const splitCompanyLoc = (line: string): { company: string; location?: string } => {
  const parts = line.split(/\s+[·•|–-]\s+/).map((s) => s.trim()).filter(Boolean);
  return { company: parts[0] ?? line.trim(), location: parts[1] };
};
const isNoise = (l: string) => /^(view job|apply|view|see all|unsubscribe|manage|jobs? (?:alert|recommendation)|new jobs?|easy apply|actively recruiting|\d+ (?:school|connection|applicant))/i.test(l) || /https?:\/\//.test(l);

export function parseAlertEmail(email: EmailLike): ParsedAlertJob[] {
  const source = senderSource(email.from) ?? "gmail_alert";
  const lines = email.text.split(/\r?\n/).map((l) => l.trim());
  const out: ParsedAlertJob[] = []; const seen = new Set<string>();
  lines.forEach((line, i) => {
    for (const raw of line.match(JOB_URL) ?? []) {
      const hit = JOB_PATTERNS.find(([re]) => re.test(raw)); if (!hit) continue;
      const url = cleanJobUrl(raw); if (seen.has(url)) continue; seen.add(url);
      const prev: string[] = [];
      for (let j = i - 1; j >= 0 && prev.length < 2; j--) {
        const l = lines[j]!;
        if (!l) { if (prev.length) break; continue; }
        if (isNoise(l)) { if (prev.length) break; continue; }
        prev.push(l);
      }
      const job: ParsedAlertJob = { source: senderSource(email.from) ?? hit[1], url };
      if (prev.length === 2) { job.title = prev[1]; Object.assign(job, splitCompanyLoc(prev[0]!)); }
      else if (prev.length === 1) job.title = prev[0];
      out.push(job);
    }
  });
  return out;
}

/** Jobs with title+company become structured input; otherwise URL-only so the pipeline fetches/normalizes. */
export function alertToIngestRequests(email: EmailLike): IngestRequest[] {
  return parseAlertEmail(email).map((j) => {
    const key = `alert:${j.url}`;
    if (j.title && j.company) {
      const job: StructuredJobInput = { title: j.title, company: j.company, location: j.location, applyUrl: j.url, sourceUrl: j.url };
      return { source: j.source, job, url: j.url, idempotencyKey: key, note: `From alert: ${email.subject}` } as IngestRequest;
    }
    return { source: j.source, url: j.url, idempotencyKey: key, note: `From alert: ${email.subject}` } as IngestRequest;
  });
}
