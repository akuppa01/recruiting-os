// Runs source adapters, records honest health, canonicalizes and dedupes. One failing adapter never blocks the others.
import type { Ctx, DiscoveredJob, SourceAdapter, SourceHealthStore, SourceId, SourceRunResult } from "@ros/core";
import { normToken } from "../normalize/index.js";
import { canonicalizeUrl, urlKey } from "./url.js";
import { errMsg, pool } from "./util.js";

export interface RunDiscoveryDeps {
  adapters: SourceAdapter[]; healthStore?: SourceHealthStore;
  since?: string; limit?: number; concurrency?: number;
}
export interface SourceSummary { source: SourceId; found: number; error?: string; notConfigured?: string; healthError?: string }
export interface RunDiscoveryResult { jobs: DiscoveredJob[]; sources: SourceSummary[]; duplicatesDropped: number }

const PLACEHOLDER_COMPANY = "Unknown company";

export async function runDiscovery(ctx: Ctx, deps: RunDiscoveryDeps): Promise<RunDiscoveryResult> {
  const results: Array<{ adapter: SourceAdapter; r: SourceRunResult; healthError?: string }> = await pool(deps.adapters, deps.concurrency ?? 4, async (adapter) => {
    let r: SourceRunResult;
    try { r = await adapter.run(ctx, { since: deps.since, limit: deps.limit }); }
    catch (e) { r = { source: adapter.id, jobs: [], error: `adapter crashed: ${errMsg(e)}` }; }
    let healthError: string | undefined;
    if (deps.healthStore) { try { await deps.healthStore.record(ctx, r); } catch (e) { healthError = errMsg(e); } }
    return { adapter, r, healthError };
  });

  const byUrl = new Map<string, DiscoveredJob>();
  const byContent = new Map<string, DiscoveredJob>();
  const jobs: DiscoveredJob[] = [];
  let dropped = 0;

  for (const { r } of results) {
    for (const d0 of r.jobs) {
      // An adapter that reports no canonical URL for a job that still needs enrichment (e.g. an unresolved email tracking link)
      // is saying the URL is NOT an identity: every such link canonicalizes to the same address and would collapse all jobs into one.
      const urlIsIdentity = !(d0.needsEnrichment && !d0.canonicalUrl);
      const raw = urlIsIdentity ? (d0.canonicalUrl ?? d0.job.applyUrl ?? d0.job.sourceUrl ?? null) : null;
      const canonicalUrl = raw ? canonicalizeUrl(raw) : null;
      const d: DiscoveredJob = { ...d0, canonicalUrl };
      const uk = canonicalUrl ? urlKey(canonicalUrl) : null;
      const ck = d.job.company && d.job.company !== PLACEHOLDER_COMPANY && d.job.title
        ? `${normToken(d.job.company)}|${normToken(d.job.title)}|${normToken(d.job.location)}` : null;

      const existing = (uk && byUrl.get(uk)) || (ck && byContent.get(ck)) || null;
      if (existing) {
        dropped++;
        // Keep the first sighting but fold in anything it lacks (e.g. school requirements, description).
        if (!existing.schoolRequirements && d.schoolRequirements) existing.schoolRequirements = d.schoolRequirements;
        if (!existing.job.description && d.job.description) existing.job = { ...existing.job, description: d.job.description };
        if (!existing.job.deadline && d.job.deadline) existing.job = { ...existing.job, deadline: d.job.deadline };
        continue;
      }
      if (uk) byUrl.set(uk, d);
      if (ck) byContent.set(ck, d);
      jobs.push(d);
    }
  }

  return {
    jobs: deps.limit ? jobs.slice(0, deps.limit) : jobs,
    duplicatesDropped: dropped,
    sources: results.map(({ r, healthError }) => ({
      source: r.source, found: r.jobs.length,
      ...(r.error ? { error: r.error } : {}), ...(r.notConfigured ? { notConfigured: r.notConfigured } : {}), ...(healthError ? { healthError } : {}),
    })),
  };
}
