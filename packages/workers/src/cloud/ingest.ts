// Idempotent ingestion of discovered jobs: dedupe, qualify (deterministic, zero AI), set the stage, keep source evidence.
import type { Ctx, DiscoveredJob, IngestRequest, IngestSource, Preferences, ScoreBreakdown, SourceId, Store, StructuredJobInput } from "@ros/core";
import { detectAts, normalizeJob, rawFromRequest } from "../normalize/index.js";
import { qualifyJob, type QualifyResult } from "../qualify/qualify.js";
import { urlKey } from "../discovery/url.js";
import { errMsg, getJson, type FetchLike } from "../discovery/util.js";

export const mapSource = (s: SourceId): IngestSource => {
  switch (s) {
    case "greenhouse": case "lever": case "ashby": return "ats_feed";
    case "manual": return "manual_url"; case "csv": return "spreadsheet_upload"; case "whatsapp": return "whatsapp_export";
    default: return s;                                    // handshake, twelve_twenty, linkedin_alert, indeed_alert, remote_feed
  }
};

const PLACEHOLDER = (j: StructuredJobInput) => j.title === "Untitled role" || j.company === "Unknown company";

/** Resolves a URL-only discovery (email alerts) into title/company/location via the ATS's public single-job endpoint. */
export async function enrichFromAts(j: StructuredJobInput, fetchImpl: FetchLike = fetch): Promise<StructuredJobInput | null> {
  const a = detectAts(j.applyUrl ?? j.sourceUrl);
  if (!a.board || !a.jobId) return null;
  const titleCase = (s: string) => s.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  try {
    if (a.kind === "greenhouse") {
      const d = (await getJson(fetchImpl, `https://boards-api.greenhouse.io/v1/boards/${a.board}/jobs/${a.jobId}`)) as { title?: string; location?: { name?: string }; content?: string } | null;
      const b = (await getJson(fetchImpl, `https://boards-api.greenhouse.io/v1/boards/${a.board}`).catch(() => null)) as { name?: string } | null;
      if (d?.title) return { ...j, title: d.title, company: b?.name ?? titleCase(a.board), location: d.location?.name ?? j.location, description: d.content ?? j.description };
    } else if (a.kind === "lever") {
      const d = (await getJson(fetchImpl, `https://api.lever.co/v0/postings/${a.board}/${a.jobId}`)) as { text?: string; categories?: { location?: string }; descriptionPlain?: string } | null;
      if (d?.text) return { ...j, title: d.text, company: titleCase(a.board), location: d.categories?.location ?? j.location, description: d.descriptionPlain ?? j.description };
    } else if (a.kind === "ashby") {
      const l = (await getJson(fetchImpl, `https://api.ashbyhq.com/posting-api/job-board/${a.board}`)) as { jobs?: Array<{ id?: string; title?: string; location?: string; descriptionPlain?: string }> } | null;
      const d = l?.jobs?.find((x) => x.id === a.jobId);
      if (d?.title) return { ...j, title: d.title, company: titleCase(a.board), location: d.location ?? j.location, description: d.descriptionPlain ?? j.description };
    }
  } catch { /* leave unresolved */ }
  return null;
}

export type IngestOutcome = "created" | "existing" | "duplicate" | "unresolved";
export interface IngestResult { outcome: IngestOutcome; jobId: string | null; decision?: QualifyResult["decision"]; score?: number }

export interface IngestOptions { now?: Date; enrich?: (j: StructuredJobInput) => Promise<StructuredJobInput | null> }

const toScore = (q: QualifyResult): ScoreBreakdown => ({
  total: q.score, roleFit: q.breakdown.roleFit, comp: 0, conversion: 0, responsibility: 0,
  flexibility: q.breakdown.location, upside: q.breakdown.tech, entrepreneurialCompat: 0,
  hardRejects: q.hardRejects, rationale: q.reasons.join("; ").slice(0, 900), decision: q.decision,
});

/**
 * Re-running with the same discovery never duplicates: the ingestion idempotency key is derived from the canonical URL
 * (or source + ref when there is none), and a finished ingestion is skipped before any parsing or qualification work.
 */
export async function ingestDiscovered(store: Store, ctx: Ctx, d: DiscoveredJob, prefs: Preferences, o: IngestOptions = {}): Promise<IngestResult> {
  const key = `v3:${d.canonicalUrl ? urlKey(d.canonicalUrl) : `src:${d.source}:${d.sourceRef}`}`;
  let job = d.job;
  const existing = await store.createIngestion(ctx, { source: mapSource(d.source), job, idempotencyKey: key } as IngestRequest);
  if (existing.status === "done") return { outcome: "existing", jobId: existing.jobId };

  if (PLACEHOLDER(job) && o.enrich) { const e = await o.enrich(job).catch(() => null); if (e) job = e; }
  const unresolved = PLACEHOLDER(job);
  if (d.schoolRequirements) job = { ...job, description: `${job.description ?? ""}\n\n[School requirements, preserved verbatim]\n${d.schoolRequirements}`.trim() };

  try {
    const req = { source: mapSource(d.source), job, idempotencyKey: key } as IngestRequest;
    const normalized = normalizeJob(rawFromRequest(req));
    const { job: row, duplicate } = await store.upsertJob(ctx, existing.id, normalized);
    await store.updateIngestion(ctx, existing.id, { status: "done", jobId: row.id });
    if (duplicate) { await store.logEvent(ctx, "job.duplicate", "job", row.id, { source: d.source }); return { outcome: "duplicate", jobId: row.id }; }

    const q = qualifyJob(normalized, prefs, o.now ?? new Date(), { manual: d.source === "manual" });
    const stage = q.decision === "qualify" ? "qualified" : q.decision === "needs_review" ? "scored" : "archived";
    await store.setJobStage(ctx, row.id, stage, toScore(q));
    await store.logEvent(ctx, "job.qualified", "job", row.id, { source: d.source, evidence: d.evidence.kind, decision: q.decision, score: q.score, company: normalized.company, title: normalized.title });
    return { outcome: unresolved ? "unresolved" : "created", jobId: row.id, decision: q.decision, score: q.score };
  } catch (e) {
    await store.updateIngestion(ctx, existing.id, { status: "failed", error: errMsg(e).slice(0, 300), attempts: existing.attempts + 1 }).catch(() => undefined);
    throw e;
  }
}
