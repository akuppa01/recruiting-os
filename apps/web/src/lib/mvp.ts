// MVP processing: bounded, persisted, retryable. No research/resume/apply stages; the user applies manually.
// Every step writes state to the database (ingestion status + job stage), so interrupted work is recoverable by sweepPending().
import type { Ctx, IngestionRow, IngestRequest, NormalizedJob, ScoreBreakdown, Store, StructuredJobInput } from "@ros/core";
import { SupabaseStore } from "@ros/db";
import { detectAts, normalizeJob, rawFromRequest, parseAshby, parseGreenhouse, parseLever, type AtsFeed } from "@ros/workers";
import { BOARDS } from "./discover-config";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ------------------------------------------------------------------ relevance filters: Summer 2027 internships and fellowships (PM, GTM, strategy, PMM, partnerships, bizops, growth)
const INTERN = /\b(intern|interns|internship|fellow|fellowship|co-?op|summer associate)\b/i;
const ROLE_PRIMARY = /(product (management|manager)|\bapm\b|go[- ]to[- ]market|\bgtm\b|growth strategy|business strategy|corporate strategy|strateg(y|ic) (&|and )?(operations|partnerships?)|strategic partnerships?|product marketing|strategy)/i;
const ROLE_ANY = /(product (management|manager)|\bpm\b|\bapm\b|product marketing|go[- ]to[- ]market|\bgtm\b|growth|strateg|business (operations|analyst|development)|bizops|partnership|founder|chief of staff|\bmba\b|revenue|operations|marketing|program)/i;
const TITLE_EXCLUDE = /\b(engineer|engineering|developer|designer|design|counsel|legal|recruit|scientist|research|researcher|machine learning|software|data science|security|infrastructure|hardware|firmware|accountant|technical|ux|ui)\b/i;
const US_HIT = /(texas|\btx\b|austin|dallas|houston|san antonio|new york|\bnyc\b|\bny\b|california|\bca\b|san francisco|\bsf\b|bay area|los angeles|san jose|san mateo|palo alto|mountain view|menlo park|oakland|san diego|miami|florida|\bfl\b|united states|\busa\b|\bus\b|\bamer\b|north america)/i;
const REMOTE_HIT = /remote/i;
const FOREIGN_HIT = /(ireland|united kingdom|\buk\b|emea|canada|netherlands|germany|france|india|apac|australia|singapore|japan|brazil|mexico|europe|london|toronto|dublin|berlin|paris)/i;
const TECH_WORDS = ["api", "apis", "developer", "developers", "platform", "saas", "ai", "machine learning", "llm", "data", "cloud", "infrastructure", "devtools", "technical", "sdk", "b2b", "engineering"];

export const titleMatches = (t: string) => INTERN.test(t) && ROLE_ANY.test(t) && !TITLE_EXCLUDE.test(t);
export const locationOk = (loc: string | null | undefined) => {
  const l = loc ?? "";
  return US_HIT.test(l) || (REMOTE_HIT.test(l) && !FOREIGN_HIT.test(l));
};
/** Summer 2027 only: rejects postings that name a different season/year and never mention Summer 2027. */
export function seasonOk(text: string): boolean {
  if (/summer\s*(of\s*)?2027|2027\s*summer|summer\s*'27/i.test(text)) return true;
  const other = /(winter|fall|autumn|spring)\s*(of\s*)?20\d\d|summer\s*(of\s*)?20(2[0-6]|2[89])|\b20(25|26|28)\s*(summer|intern)/i.test(text);
  return !other;
}

/** Transparent heuristic: only role fit, location and technical-advantage signals are assessed. Never invents comp/size/conversion. */
export function fitScore(n: NormalizedJob, manual: boolean): ScoreBreakdown {
  const title = n.title;
  const roleFit = ROLE_PRIMARY.test(title) ? 100 : ROLE_ANY.test(title) ? 80 : manual ? 40 : 0;
  const locOk = locationOk(n.location) || n.remote === true;
  const flexibility = locOk ? 100 : 40;
  const hay = `${title}\n${n.description}`.toLowerCase();
  const hits = TECH_WORDS.filter((w) => new RegExp(`\\b${w.replace(/ /g, "\\s+")}\\b`).test(hay));
  const upside = n.description ? Math.min(100, hits.length * 12 + (/(technical|developer|platform|\bai\b|api)/i.test(title) ? 20 : 0)) : 0;
  const stated27 = n.eligibility.summer2027 === true;
  const season = stated27 ? 100 : 50;
  const total = Math.max(0, Math.min(100, Math.round(0.45 * roleFit + 0.2 * flexibility + 0.2 * upside + 0.15 * season)));
  const salary = n.salaryMin ? ` Posted pay: $${n.salaryMin}${n.salaryMax && n.salaryMax !== n.salaryMin ? `–$${n.salaryMax}` : ""}.` : "";
  const rationale =
    `${roleFit >= 80 ? "Title matches a target role" : "Title does not match target-role keywords"}; ` +
    `${locOk ? "location is remote or in a target state" : "location is outside Remote/TX/NY/CA/FL or unknown"}; ` +
    `${stated27 ? "Summer 2027 is stated" : "season is not stated in the posting (check before applying)"}; ` +
    `${hits.length ? `technical signals: ${hits.slice(0, 5).join(", ")}` : "no technical signals found in the posting"}.${salary} ` +
    `Compensation, company size and conversion were not assessed.`;
  return {
    total, roleFit, comp: 0, conversion: 0, responsibility: 0, flexibility, upside, entrepreneurialCompat: 0,
    hardRejects: [], rationale, decision: total >= 55 ? "qualify" : "needs_review",
  };
}

// ------------------------------------------------------------------ URL enrichment
const UA = "Mozilla/5.0 (compatible; RecruitingOS/1.0)";
async function getJson(url: string, ms = 15000): Promise<any | null> {
  try {
    const r = await fetch(url, { headers: { accept: "application/json", "user-agent": UA }, signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
const strip = (h: string) => h.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/<br\s*\/?>|<\/p>|<\/li>/gi, "\n").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim();
const titleCase = (s: string) => s.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

async function jobFromUrl(url: string): Promise<StructuredJobInput | null> {
  const a = detectAts(url);
  if (a.kind === "greenhouse" && a.board && a.jobId) {
    const [j, b] = await Promise.all([getJson(`https://boards-api.greenhouse.io/v1/boards/${a.board}/jobs/${a.jobId}`), getJson(`https://boards-api.greenhouse.io/v1/boards/${a.board}`)]);
    if (j?.title) return { title: j.title, company: b?.name ?? titleCase(a.board), location: j.location?.name, description: strip(String(j.content ?? "")), applyUrl: j.absolute_url ?? url, sourceUrl: j.absolute_url ?? url };
  }
  if (a.kind === "lever" && a.board && a.jobId) {
    const j = await getJson(`https://api.lever.co/v0/postings/${a.board}/${a.jobId}`);
    if (j?.text) return { title: j.text, company: titleCase(a.board), location: j.categories?.location, description: j.descriptionPlain ?? strip(String(j.description ?? "")), applyUrl: j.applyUrl ?? j.hostedUrl ?? url, sourceUrl: j.hostedUrl ?? url };
  }
  if (a.kind === "ashby" && a.board && a.jobId) {
    const list = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${a.board}`, 25000);
    const j = (list?.jobs ?? []).find((x: any) => x.id === a.jobId);
    if (j?.title) return { title: j.title, company: titleCase(a.board), location: j.location, description: j.descriptionPlain ?? strip(String(j.descriptionHtml ?? "")), applyUrl: j.applyUrl ?? j.jobUrl ?? url, sourceUrl: j.jobUrl ?? url };
  }
  // Generic page: JSON-LD JobPosting, then OpenGraph/<title>.
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" }, signal: AbortSignal.timeout(15000), redirect: "follow" });
    if (!r.ok) return null;
    const html = (await r.text()).slice(0, 2_000_000);
    for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const parsed = JSON.parse(m[1]!);
        const nodes: any[] = Array.isArray(parsed) ? parsed : parsed["@graph"] ?? [parsed];
        const jp = nodes.find((n) => String(n?.["@type"]).includes("JobPosting"));
        if (jp?.title) {
          const loc = Array.isArray(jp.jobLocation) ? jp.jobLocation[0] : jp.jobLocation;
          const addr = loc?.address;
          const place = [addr?.addressLocality, addr?.addressRegion].filter(Boolean).join(", ") || (jp.jobLocationType === "TELECOMMUTE" ? "Remote" : undefined);
          return { title: String(jp.title), company: jp.hiringOrganization?.name ?? new URL(url).hostname.replace(/^www\./, ""), location: place, description: strip(String(jp.description ?? "")), applyUrl: url, sourceUrl: url, deadline: jp.validThrough ? String(jp.validThrough).slice(0, 10) : undefined };
        }
      } catch { /* try next block */ }
    }
    const og = (p: string) => html.match(new RegExp(`<meta[^>]+property=["']og:${p}["'][^>]+content=["']([^"']+)["']`, "i"))?.[1];
    const t = og("title") ?? html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
    if (t) {
      const parts = strip(t).split(/\s+[-–—|@]\s+/);
      return { title: parts[0]!.slice(0, 200), company: og("site_name") ?? parts[1] ?? new URL(url).hostname.replace(/^www\./, ""), description: strip(og("description") ?? ""), applyUrl: url, sourceUrl: url };
    }
  } catch { /* fall through */ }
  return null;
}

async function normalizeRequest(req: IngestRequest): Promise<NormalizedJob> {
  if (req.url && !req.job && !req.text) {
    const enriched = await jobFromUrl(req.url);
    if (enriched) return normalizeJob({ url: req.url, job: enriched });
  }
  return normalizeJob(rawFromRequest(req));
}

// ------------------------------------------------------------------ processing (idempotent; safe to re-run)
export async function processIngestion(store: Store, ctx: Ctx, ingestionId: string): Promise<"done" | "duplicate" | "failed" | "skipped"> {
  const ing = await store.getIngestion(ctx, ingestionId);
  if (!ing || ing.status === "done" || ing.status === "dead_letter") return "skipped";
  await store.updateIngestion(ctx, ingestionId, { status: "processing" });
  try {
    const n = await normalizeRequest(ing.request);
    const manual = ing.request.source === "manual_url" || ing.request.source === "manual_text";
    const { job, duplicate } = await store.upsertJob(ctx, ingestionId, n);
    if (duplicate) {
      await store.updateIngestion(ctx, ingestionId, { status: "done", jobId: job.id });
      await store.logEvent(ctx, "job.duplicate", "job", job.id, { duplicateOf: job.duplicateOf });
      return "duplicate";
    }
    const fit = fitScore(n, manual);
    await store.setJobStage(ctx, job.id, fit.decision === "qualify" ? "qualified" : "scored", fit);
    await store.updateIngestion(ctx, ingestionId, { status: "done", jobId: job.id, error: null });
    await store.logEvent(ctx, "job.scored", "job", job.id, { company: n.company, title: n.title, total: fit.total });
    return "done";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await store.updateIngestion(ctx, ingestionId, { status: "failed", error: msg.slice(0, 500), attempts: (ing.attempts ?? 0) + 1 }).catch(() => {});
    await store.logEvent(ctx, "ingestion.failed", "ingestion", ingestionId, { error: msg.slice(0, 500) }).catch(() => {});
    return "failed";
  }
}

export async function processWithin(store: Store, ctx: Ctx, ingestionId: string, ms = 25000) {
  return Promise.race([
    processIngestion(store, ctx, ingestionId),
    new Promise<"deferred">((r) => setTimeout(() => r("deferred"), ms)),
  ]);
}

/** Recovery sweep (cron + Discover button): requeue stale/failed work, then process it. Bounded by `budgetMs`. */
export async function sweepPending(store: Store, limit = 20, budgetMs = 40000) {
  if (store instanceof SupabaseStore) {
    const stale = new Date(Date.now() - 5 * 60_000).toISOString();
    await store.sb.from("ingestions").update({ status: "accepted" }).eq("status", "processing").lt("updated_at", stale);
    await store.sb.from("ingestions").update({ status: "accepted" }).eq("status", "failed").lt("attempts", 3);
  }
  const t0 = Date.now();
  const rows: IngestionRow[] = await store.claimIngestions(limit);
  let done = 0;
  for (const r of rows) {
    if (Date.now() - t0 > budgetMs) { await store.updateIngestion(r.ctx, r.id, { status: "accepted" }); continue; }
    const out = await processIngestion(store, r.ctx, r.id);
    if (out === "done" || out === "duplicate") done++;
  }
  return { claimed: rows.length, processed: done };
}

// ------------------------------------------------------------------ discovery (public ATS feeds)
async function fetchBoard(kind: AtsFeed, board: string): Promise<StructuredJobInput[]> {
  const url = kind === "greenhouse" ? `https://boards-api.greenhouse.io/v1/boards/${board}/jobs`
    : kind === "lever" ? `https://api.lever.co/v0/postings/${board}?mode=json`
    : `https://api.ashbyhq.com/posting-api/job-board/${board}`;
  const r = await fetch(url, { headers: { accept: "application/json", "user-agent": UA }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const json = await r.json();
  return kind === "greenhouse" ? parseGreenhouse(board, json) : kind === "lever" ? parseLever(board, json) : parseAshby(board, json);
}

async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]!); }
  }));
  return out;
}

export interface DiscoverSummary { boards: number; boardErrors: string[]; matched: number; imported: number; alreadyHad: number; failed: number; deferred: number }

export async function discoverJobs(store: Store, ctx: Ctx, opts: { maxJobs?: number; budgetMs?: number } = {}): Promise<DiscoverSummary> {
  const t0 = Date.now();
  const budget = opts.budgetMs ?? 45000;
  const boardErrors: string[] = [];
  const found: StructuredJobInput[] = [];
  await pool(BOARDS, 10, async (b) => {
    try {
      for (const j of await fetchBoard(b.ats, b.board)) {
        if (!j.applyUrl || !titleMatches(j.title) || !locationOk(j.location)) continue;
        found.push({ ...j, company: b.name });
      }
    } catch (e) { boardErrors.push(`${b.name}: ${e instanceof Error ? e.message : "failed"}`); }
  });

  // Greenhouse lists carry no description: fetch details only for the few title/location matches, then apply the season check.
  const detailed: StructuredJobInput[] = [];
  await pool(found, 8, async (j) => {
    let full = j;
    if (!j.description && j.applyUrl) {
      const a = detectAts(j.applyUrl);
      if (a.kind === "greenhouse" && a.board && a.jobId) {
        const d = await getJson(`https://boards-api.greenhouse.io/v1/boards/${a.board}/jobs/${a.jobId}`);
        if (d?.content) full = { ...j, description: strip(String(d.content)) };
      }
    }
    if (seasonOk(`${full.title}\n${full.description ?? ""}`)) detailed.push(full);
  });

  const ranked = detailed
    .map((j) => ({ j, s: fitScore(normalizeJob(rawFromRequest({ source: "ats_feed", job: j } as IngestRequest)), false).total }))
    .sort((a, b) => b.s - a.s)
    .slice(0, opts.maxJobs ?? 80)
    .map((x) => x.j);

  const sum: DiscoverSummary = { boards: BOARDS.length, boardErrors, matched: found.length, imported: 0, alreadyHad: 0, failed: 0, deferred: 0 };
  await pool(ranked, 8, async (job) => {
    if (Date.now() - t0 > budget) { sum.deferred++; return; }
    const ing = await store.createIngestion(ctx, { source: "ats_feed", job, idempotencyKey: `ats:${job.applyUrl}` });
    if (ing.status === "done") { sum.alreadyHad++; return; }
    const out = await processIngestion(store, ctx, ing.id);
    if (out === "done") sum.imported++; else if (out === "duplicate") sum.alreadyHad++; else if (out === "failed") sum.failed++;
  });
  return sum;
}
