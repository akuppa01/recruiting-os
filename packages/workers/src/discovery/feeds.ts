// Public ATS job feeds (Greenhouse / Lever / Ashby). Official public endpoints only; no authentication, no scraping.
import type { SourceAdapter, SourceRunResult, DiscoveredJob } from "@ros/core";
import type { StructuredJobInput } from "@ros/core";
import { parseAshby, parseGreenhouse, parseLever } from "../connectors/index.js";
import { detectAts } from "../normalize/index.js";
import { locationOk, seasonOk, titleMatches } from "../qualify/filters.js";
import { canonicalizeUrl } from "./url.js";
import { errMsg, getJson, pool, stripHtml, type FetchLike } from "./util.js";

export interface FeedBoard { board: string; name: string }
export interface FeedOptions {
  boards: FeedBoard[]; fetchImpl?: FetchLike; concurrency?: number; timeoutMs?: number;
  /** Extra preferred locations (from Preferences.locationsPreferred). */
  extraLocations?: string[];
}

const feedUrl = (kind: "greenhouse" | "lever" | "ashby", board: string) =>
  kind === "greenhouse" ? `https://boards-api.greenhouse.io/v1/boards/${board}/jobs` // list WITHOUT bodies: small and fast
  : kind === "lever" ? `https://api.lever.co/v0/postings/${board}?mode=json`
  : `https://api.ashbyhq.com/posting-api/job-board/${board}`;

const parseList = (kind: "greenhouse" | "lever" | "ashby", board: string, json: unknown): StructuredJobInput[] =>
  kind === "greenhouse" ? parseGreenhouse(board, json) : kind === "lever" ? parseLever(board, json) : parseAshby(board, json);

export function createFeedAdapter(kind: "greenhouse" | "lever" | "ashby", o: FeedOptions): SourceAdapter {
  const f: FetchLike = o.fetchImpl ?? fetch;
  return {
    id: kind, kind: "feed",
    async run(_ctx, opts): Promise<SourceRunResult> {
      const jobs: DiscoveredJob[] = [];
      const failures: string[] = [];
      await pool(o.boards, o.concurrency ?? 8, async (b) => {
        try {
          const list = parseList(kind, b.board, await getJson(f, feedUrl(kind, b.board), o.timeoutMs));
          const matches = list.filter((j) => j.applyUrl && titleMatches(j.title) && locationOk(j.location, o.extraLocations));
          for (const j0 of matches) {
            let j: StructuredJobInput = { ...j0, company: b.name };
            if (kind === "greenhouse" && !j.description) {
              // Detail fetch only for the few title/location matches (the list has no body).
              const id = detectAts(j.applyUrl).jobId;
              if (id) {
                try {
                  const d = (await getJson(f, `https://boards-api.greenhouse.io/v1/boards/${b.board}/jobs/${id}`, o.timeoutMs)) as { content?: string };
                  if (d?.content) j = { ...j, description: stripHtml(d.content) };
                } catch { /* keep the posting without a body; the title-level season check still applies */ }
              }
            }
            if (!seasonOk(`${j.title}\n${j.description ?? ""}`)) continue;
            const id = detectAts(j.applyUrl).jobId;
            jobs.push({
              source: kind, sourceRef: `${kind}:${b.board}:${id ?? j.applyUrl}`,
              canonicalUrl: j.applyUrl ? canonicalizeUrl(j.applyUrl) : null, job: j,
              evidence: { kind: "feed", board: b.board },
            });
          }
        } catch (e) { failures.push(`${b.name}: ${errMsg(e)}`); }
      });
      const capped = opts?.limit ? jobs.slice(0, opts.limit) : jobs;
      if (failures.length === 0) return { source: kind, jobs: capped };
      const msg = `${failures.length}/${o.boards.length} boards unavailable: ${failures.slice(0, 5).join("; ")}`;
      return { source: kind, jobs: capped, error: msg }; // partial data + error => degraded; no data + error => failed
    },
  };
}
