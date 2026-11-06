import * as cheerio from "cheerio";
import type { Fetcher, FetchedPage } from "./types.js";

export function extractPage(url: string, status: number, html: string): FetchedPage {
  const $ = cheerio.load(html);
  const title = $("title").first().text().trim() || undefined;
  const description =
    $('meta[name="description"]').attr("content")?.trim() ||
    $('meta[property="og:description"]').attr("content")?.trim() || undefined;
  $("script,style,noscript,svg,nav,footer").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 8000);
  return { url, status, text, title, description };
}

/** Default fetcher: public pages only, no auth, bounded size/time. Returns null on any failure. */
export const defaultFetcher: Fetcher = async (url) => {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { "user-agent": "RecruitingOS-Research/0.1 (public pages only)" },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("html")) return null;
    return extractPage(url, res.status, (await res.text()).slice(0, 500_000));
  } catch { return null; }
};
