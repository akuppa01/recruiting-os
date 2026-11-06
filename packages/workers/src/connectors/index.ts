// Public ATS feed parsers. Shapes derived from official docs:
//  Greenhouse Job Board API  https://developers.greenhouse.io/job-board.html  (GET boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true)
//  Lever Postings API        https://github.com/lever/postings-api            (GET api.lever.co/v0/postings/{site}?mode=json)
//  Ashby Job Postings API    https://developers.ashbyhq.com/docs/public-job-posting-api (GET api.ashbyhq.com/posting-api/job-board/{name})
import type { StructuredJobInput } from "@ros/core";

const stripHtml = (h: string | undefined | null) =>
  (h ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/<br\s*\/?>|<\/p>|<\/li>/gi, "\n").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim();

export function parseGreenhouse(board: string, json: any): StructuredJobInput[] {
  return (json?.jobs ?? []).map((j: any) => ({
    title: String(j.title),
    company: board, // list endpoint has no company_name (verified vs docs); caller passes the board token
    location: j.location?.name,
    description: stripHtml(j.content),
    applyUrl: j.absolute_url,
    sourceUrl: j.absolute_url,
    postedAt: j.updated_at,
  }));
}

export function parseLever(site: string, json: any): StructuredJobInput[] {
  return (Array.isArray(json) ? json : []).map((j: any) => {
    const sr = j.salaryRange;
    return {
      title: String(j.text),
      company: site,
      location: j.categories?.location ?? j.country,
      description: j.descriptionPlain ?? stripHtml(j.description),
      applyUrl: j.applyUrl ?? j.hostedUrl,
      sourceUrl: j.hostedUrl,
      salaryMin: sr?.min, salaryMax: sr?.max, salaryCurrency: sr?.currency, // NOTE: sr.interval may be per-year or per-hour; scorer treats <500 as hourly
      postedAt: typeof j.createdAt === "number" ? new Date(j.createdAt).toISOString() : undefined, // createdAt not confirmed in docs; optional
    };
  });
}

export function parseAshby(board: string, json: any): StructuredJobInput[] {
  return (json?.jobs ?? []).filter((j: any) => j.isListed !== false).map((j: any) => ({
    title: String(j.title),
    company: board,
    location: j.location ?? j.address?.postalAddress?.addressLocality,
    description: j.descriptionPlain ?? stripHtml(j.descriptionHtml),
    applyUrl: j.applyUrl ?? j.jobUrl,
    sourceUrl: j.jobUrl,
    postedAt: j.publishedAt,
  }));
}

export type AtsFeed = "greenhouse" | "lever" | "ashby";
export const feedUrl = (kind: AtsFeed, board: string): string =>
  kind === "greenhouse" ? `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`
  : kind === "lever" ? `https://api.lever.co/v0/postings/${board}?mode=json`
  : `https://api.ashbyhq.com/posting-api/job-board/${board}`;

/** Network fetch + parse. Exported but only unit-tested against doc-derived fixtures (not live-verified). */
export async function fetchFeed(kind: AtsFeed, board: string, fetchImpl: typeof fetch = fetch): Promise<StructuredJobInput[]> {
  const res = await fetchImpl(feedUrl(kind, board), { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${kind} feed ${board} HTTP ${res.status}`);
  const json = await res.json();
  return kind === "greenhouse" ? parseGreenhouse(board, json) : kind === "lever" ? parseLever(board, json) : parseAshby(board, json);
}
