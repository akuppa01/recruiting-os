// Public remote-job JSON feeds (Remotive, RemoteOK). Documented public APIs; internship/fellowship roles only.
import type { DiscoveredJob, SourceAdapter, SourceRunResult } from "@ros/core";
import { locationOk, seasonOk, titleMatches } from "../qualify/filters.js";
import { canonicalizeUrl } from "./url.js";
import { errMsg, getJson, stripHtml, type FetchLike } from "./util.js";

const remoteOk = (loc: string | null | undefined) => !loc || /(worldwide|anywhere|global|americas)/i.test(loc) || locationOk(loc);

interface Item { id: string; title: string; company: string; location: string; url: string; description: string; date?: string }

function toJobs(source: "remote_feed", items: Item[], feed: string): DiscoveredJob[] {
  const out: DiscoveredJob[] = [];
  for (const it of items) {
    if (!it.url || !titleMatches(it.title) || !remoteOk(it.location)) continue;
    if (!seasonOk(`${it.title}\n${it.description}`)) continue;
    out.push({
      source, sourceRef: `${feed}:${it.id}`, canonicalUrl: canonicalizeUrl(it.url),
      job: { title: it.title, company: it.company, location: it.location ? `Remote (${it.location})` : "Remote", description: it.description, applyUrl: it.url, sourceUrl: it.url, postedAt: it.date },
      evidence: { kind: "feed", board: feed, receivedAt: it.date },
    });
  }
  return out;
}

export function createRemotiveAdapter(o: { fetchImpl?: FetchLike } = {}): SourceAdapter {
  const f = o.fetchImpl ?? fetch;
  return {
    id: "remote_feed", kind: "feed",
    async run(): Promise<SourceRunResult> {
      try {
        const j = (await getJson(f, "https://remotive.com/api/remote-jobs?search=intern")) as { jobs?: Array<Record<string, unknown>> };
        const items: Item[] = (j.jobs ?? []).map((x) => ({
          id: String(x.id), title: String(x.title ?? ""), company: String(x.company_name ?? ""), location: String(x.candidate_required_location ?? ""),
          url: String(x.url ?? ""), description: stripHtml(String(x.description ?? "")), date: x.publication_date ? String(x.publication_date) : undefined,
        }));
        return { source: "remote_feed", jobs: toJobs("remote_feed", items, "remotive") };
      } catch (e) { return { source: "remote_feed", jobs: [], error: `remotive: ${errMsg(e)}` }; }
    },
  };
}

export function createRemoteOkAdapter(o: { fetchImpl?: FetchLike } = {}): SourceAdapter {
  const f = o.fetchImpl ?? fetch;
  return {
    id: "remote_feed", kind: "feed",
    async run(): Promise<SourceRunResult> {
      try {
        const arr = (await getJson(f, "https://remoteok.com/api")) as Array<Record<string, unknown>>;
        const items: Item[] = (Array.isArray(arr) ? arr : []).filter((x) => x && x.id && x.position).map((x) => ({
          id: String(x.id), title: String(x.position ?? ""), company: String(x.company ?? ""), location: String(x.location ?? ""),
          url: String(x.url ?? x.apply_url ?? ""), description: stripHtml(String(x.description ?? "")), date: x.date ? String(x.date) : undefined,
        }));
        return { source: "remote_feed", jobs: toJobs("remote_feed", items, "remoteok") };
      } catch (e) { return { source: "remote_feed", jobs: [], error: `remoteok: ${errMsg(e)}` }; }
    },
  };
}

/** One "remote_feed" source made of both feeds; a failing feed degrades the source but never hides the other's jobs. */
export function createRemoteFeedAdapter(o: { fetchImpl?: FetchLike } = {}): SourceAdapter {
  const parts = [createRemotiveAdapter(o), createRemoteOkAdapter(o)];
  return {
    id: "remote_feed", kind: "feed",
    async run(ctx, opts): Promise<SourceRunResult> {
      const rs = await Promise.all(parts.map((p) => p.run(ctx, opts)));
      const jobs = rs.flatMap((r) => r.jobs);
      const errors = rs.map((r) => r.error).filter((e): e is string => !!e);
      return { source: "remote_feed", jobs, ...(errors.length ? { error: errors.join("; ") } : {}) };
    },
  };
}
