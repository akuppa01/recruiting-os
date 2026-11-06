// CSV / Google Sheet rows / WhatsApp export -> IngestRequest[]
import { createHash } from "node:crypto";
import type { IngestRequest, StructuredJobInput } from "@ros/core";

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); f = ""; if (row.some((x) => x.trim())) rows.push(row); row = []; }
    else f += c;
  }
  row.push(f); if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

const ALIASES: Record<string, string[]> = {
  title: ["title", "job title", "role", "position", "job"], company: ["company", "employer", "organization", "organisation", "company name"],
  url: ["url", "link", "job url", "apply url", "application link", "job link", "posting"], location: ["location", "city", "office"],
  description: ["description", "jd", "job description", "details"], deadline: ["deadline", "due", "apply by", "due date", "closing date"],
};
const norm = (s: string) => s.trim().toLowerCase();
const isUrl = (s: string) => /^https?:\/\/\S+$/.test(s.trim());

/** rows[0] is the header. Works for CSV and Google Sheet get_values output alike. */
export function rowsToIngestRequests(rows: string[][], source: IngestRequest["source"] = "spreadsheet_upload"): { requests: IngestRequest[]; skipped: Array<{ row: number; reason: string }> } {
  const [head, ...data] = rows; const requests: IngestRequest[] = []; const skipped: Array<{ row: number; reason: string }> = [];
  if (!head) return { requests, skipped };
  const idx = (k: string) => head.findIndex((h) => ALIASES[k]!.includes(norm(h)));
  const ix = Object.fromEntries(Object.keys(ALIASES).map((k) => [k, idx(k)])) as Record<string, number>;
  data.forEach((r, n) => {
    const get = (k: string) => (ix[k]! >= 0 ? (r[ix[k]!] ?? "").trim() : "");
    const url = get("url"), title = get("title"), company = get("company"), description = get("description");
    const stableId = createHash("sha256").update(`${source}|${url || `${company}|${title}`}`.toLowerCase()).digest("hex").slice(0, 32);
    if (title && company) {
      const job: StructuredJobInput = { title, company, location: get("location") || undefined, description: description || undefined, applyUrl: isUrl(url) ? url : undefined, deadline: get("deadline") || undefined };
      requests.push({ source, job, idempotencyKey: `sheet:${stableId}` } as IngestRequest);
    } else if (isUrl(url)) requests.push({ source, url, idempotencyKey: `sheet:${stableId}` } as IngestRequest);
    else if (description.length > 40) requests.push({ source, text: description, idempotencyKey: `sheet:${stableId}` } as IngestRequest);
    else skipped.push({ row: n + 2, reason: "needs title+company, a URL, or a description" });
  });
  return { requests, skipped };
}
export const csvToIngestRequests = (csv: string, source: IngestRequest["source"] = "spreadsheet_upload") => rowsToIngestRequests(parseCsv(csv), source);

// ---- WhatsApp ----
const WA_LINE = /^\[?(\d{1,2}[/.]\d{1,2}[/.]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?\s?(?:[AaPp][Mm])?)\]?\s*(?:-\s*)?([^:]+?):\s(.*)$/;
const JOBISH = /(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|workday|icims|smartrecruiters|linkedin\.com\/(?:comm\/)?jobs|joinhandshake|12twenty|\/jobs?\b|\/careers?\b|\/apply\b|\/positions?\b|\/openings?\b)/i;
const NOT_JOB = /(chat\.whatsapp\.com|youtu\.be|youtube\.com|giphy|instagram\.com|tiktok\.com|zoom\.us|meet\.google|docs\.google\.com\/forms)/i;

export function parseWhatsAppExport(text: string, o: { includeAllUrls?: boolean } = {}): IngestRequest[] {
  const msgs: Array<{ date: string; sender: string; body: string }> = [];
  for (const line of text.replace(/‎| /g, " ").split(/\r?\n/)) {
    const m = line.match(WA_LINE);
    if (m) msgs.push({ date: m[1]!, sender: m[3]!.trim(), body: m[4]! });
    else if (msgs.length) msgs[msgs.length - 1]!.body += `\n${line}`;
  }
  const out: IngestRequest[] = []; const seen = new Set<string>();
  for (const m of msgs) {
    for (const raw of m.body.match(/https?:\/\/[^\s<>")]+/g) ?? []) {
      const url = raw.replace(/[.,;!?)]+$/, "");
      if (NOT_JOB.test(url) || (!o.includeAllUrls && !JOBISH.test(url)) || seen.has(url)) continue;
      seen.add(url);
      out.push({ source: "whatsapp_export", url, note: `WhatsApp ${m.date} from ${m.sender}: ${m.body.replace(/https?:\/\/\S+/g, "").trim().slice(0, 300)}`, idempotencyKey: `wa:${createHash("sha256").update(url).digest("hex").slice(0, 32)}` } as IngestRequest);
    }
  }
  return out;
}
