import type { ContactCandidate, ContactProvider, ContactQuery } from "./types.js";

type Fetch = typeof fetch;

/**
 * Apollo. Endpoint per https://docs.apollo.io/reference/people-api-search :
 * POST https://api.apollo.io/api/v1/mixed_people/api_search (0 credits, returns NO emails/phones).
 * Auth header `x-api-key` (docs: Authentication page). Response person fields (id, first_name, last_name[_obfuscated], title,
 * organization.name, linkedin_url) were NOT visible in fetched docs: parsed defensively. UNTESTED against the live API (no key).
 * Emails require a separate enrichment call (POST /api/v1/people/match, credits): not performed automatically.
 */
export class ApolloProvider implements ContactProvider {
  name = "apollo";
  constructor(private apiKey = process.env.APOLLO_API_KEY, private fetchFn: Fetch = fetch) {}
  isConfigured() { return !!this.apiKey; }
  async search(q: ContactQuery): Promise<ContactCandidate[]> {
    if (!this.apiKey) return [];
    const res = await this.fetchFn("https://api.apollo.io/api/v1/mixed_people/api_search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey, "cache-control": "no-cache" },
      body: JSON.stringify({ q_organization_domains_list: [q.domain], person_titles: q.titles, per_page: Math.min(q.limit ?? 10, 25), page: 1 }),
    });
    if (!res.ok) throw new Error(`apollo search failed: ${res.status}`);
    const j = (await res.json()) as { people?: Array<Record<string, any>> };
    return (j.people ?? []).map((p) => ({
      name: [p.first_name, p.last_name ?? p.last_name_obfuscated].filter(Boolean).join(" ") || "Unknown",
      title: p.title ?? null, email: typeof p.email === "string" && !p.email.includes("not_unlocked") ? p.email : null,
      linkedinUrl: p.linkedin_url ?? null, source: "apollo", providerRef: p.id,
    }));
  }
}

/**
 * Snov.io. Per https://snov.io/api : OAuth POST https://api.snov.io/v1/oauth/access_token (client_credentials),
 * then POST https://api.snov.io/v2/domain-search/prospects/start {domain, positions[], page} -> GET .../result/{task_hash}
 * (data[]: first_name,last_name,position,source_page; NO email; emails cost 1 credit via search-emails). Async polling.
 * UNTESTED against the live API (no credentials). Emails are not fetched automatically (credit spend).
 */
export class SnovProvider implements ContactProvider {
  name = "snov";
  constructor(
    private id = process.env.SNOV_CLIENT_ID, private secret = process.env.SNOV_CLIENT_SECRET,
    private fetchFn: Fetch = fetch, private sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  ) {}
  isConfigured() { return !!this.id && !!this.secret; }
  private async token(): Promise<string> {
    const res = await this.fetchFn("https://api.snov.io/v1/oauth/access_token", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials", client_id: this.id, client_secret: this.secret }),
    });
    if (!res.ok) throw new Error(`snov auth failed: ${res.status}`);
    return ((await res.json()) as { access_token: string }).access_token;
  }
  async search(q: ContactQuery): Promise<ContactCandidate[]> {
    if (!this.isConfigured()) return [];
    const auth = { authorization: `Bearer ${await this.token()}`, "content-type": "application/json" };
    const start = await this.fetchFn("https://api.snov.io/v2/domain-search/prospects/start", {
      method: "POST", headers: auth, body: JSON.stringify({ domain: q.domain, positions: q.titles.slice(0, 10), page: 1 }),
    });
    if (!start.ok) throw new Error(`snov start failed: ${start.status}`);
    const hash = ((await start.json()) as { meta?: { task_hash?: string } }).meta?.task_hash;
    if (!hash) throw new Error("snov start: no task_hash");
    for (let i = 0; i < 10; i++) {
      const r = await this.fetchFn(`https://api.snov.io/v2/domain-search/prospects/result/${hash}`, { headers: auth });
      if (!r.ok) throw new Error(`snov result failed: ${r.status}`);
      const j = (await r.json()) as { status?: string; data?: Array<Record<string, any>> };
      if (j.status === "completed") {
        return (j.data ?? []).slice(0, q.limit ?? 20).map((p) => ({
          name: [p.first_name, p.last_name].filter(Boolean).join(" ") || "Unknown", title: p.position ?? null,
          email: null, linkedinUrl: null, source: "snov", providerRef: p.search_emails_start,
        }));
      }
      await this.sleep(1500);
    }
    throw new Error("snov result: timed out");
  }
}

/** Manual / CSV provider: the user's own list. Header columns: name,title,email,linkedin,education,past_employers (';' separated lists). */
export class ManualProvider implements ContactProvider {
  name = "manual";
  constructor(private rows: ContactCandidate[] = []) {}
  isConfigured() { return true; }
  async search(_q: ContactQuery) { return this.rows; }
  static fromCsv(csv: string): ManualProvider { return new ManualProvider(parseContactsCsv(csv)); }
}

function splitCsvLine(line: string): string[] {
  const out: string[] = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur); return out.map((s) => s.trim());
}

export function parseContactsCsv(csv: string): ContactCandidate[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const head = splitCsvLine(lines[0]!).map((h) => h.toLowerCase());
  const idx = (n: string) => head.indexOf(n);
  const list = (v?: string) => (v ? v.split(";").map((s) => s.trim()).filter(Boolean) : undefined);
  return lines.slice(1).map((l) => {
    const c = splitCsvLine(l); const g = (n: string) => (idx(n) >= 0 ? c[idx(n)] || undefined : undefined);
    return { name: g("name") ?? "Unknown", title: g("title") ?? null, email: g("email") ?? null, linkedinUrl: g("linkedin") ?? null,
      source: "manual", education: list(g("education")), pastEmployers: list(g("past_employers")) };
  }).filter((c) => c.name !== "Unknown");
}
