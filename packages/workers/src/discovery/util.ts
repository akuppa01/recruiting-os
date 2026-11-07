// Small shared helpers for discovery adapters. No global state; fetch is injectable for tests.
export type FetchLike = typeof fetch;

export const stripHtml = (h: string | null | undefined) =>
  (h ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, "\n").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim();

export async function getJson(f: FetchLike, url: string, timeoutMs = 20000): Promise<unknown> {
  const r = await f(url, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; RecruitingOS/1.0)" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]!); }
  }));
  return out;
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
