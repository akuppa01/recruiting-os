// Saved-search / job-alert emails (Handshake, 12twenty, LinkedIn, Indeed) via an injected Gmail connector.
// Official alerts only: no authenticated scraping. When Gmail isn't connected the adapter reports notConfigured (never fake data).
import type { DiscoveredJob, SourceAdapter, SourceRunResult } from "@ros/core";
import { parseAlertEmail, type EmailLike } from "../gmail/alerts.js";
import type { GmailResult } from "../gmail/connector.js";
import { canonicalizeUrl } from "./url.js";
import { errMsg } from "./util.js";

export type EmailSourceId = "handshake" | "twelve_twenty" | "linkedin_alert" | "indeed_alert";

export interface EmailAdapterOptions {
  getGmail: () => GmailResult | Promise<GmailResult>;
  query?: string; max?: number;
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

export interface AlertJob { url: string; title?: string; company?: string; location?: string }

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
      for (const email of emails) {
        if (!SENDER[id].test(email.from)) continue;
        if (!Number.isNaN(since) && email.date && Date.parse(email.date) < since) continue;
        const parsed: AlertJob[] = id === "indeed_alert" ? parseIndeedEmail(email) : parseAlertEmail(email).filter((j) => j.source === id);
        const school = id === "handshake" || id === "twelve_twenty" ? extractSchoolRequirements(email.text) : undefined;
        for (const j of parsed) {
          const resolved = !!(j.title && j.company);
          jobs.push({
            source: id, sourceRef: email.messageId ?? `${email.from}:${email.subject}:${j.url}`,
            canonicalUrl: canonicalizeUrl(j.url),
            // Placeholders title/company mean "needs URL enrichment downstream"; the original URL and email are kept as evidence.
            job: { title: j.title ?? "Untitled role", company: j.company ?? "Unknown company", location: j.location, applyUrl: j.url, sourceUrl: j.url },
            evidence: { kind: "email", excerpt: resolved ? email.subject : `${email.subject} [title/company unresolved]`, receivedAt: email.date },
            ...(school ? { schoolRequirements: school } : {}),
          });
        }
      }
      return { source: id, jobs: opts?.limit ? jobs.slice(0, opts.limit) : jobs };
    },
  };
}
