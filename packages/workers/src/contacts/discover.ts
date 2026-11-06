import type { Ctx, Store } from "@ros/core";
import { rankContacts } from "./rank.js";
import type { ContactProvider, JobForRanking, RankedContact } from "./types.js";

export const DEFAULT_TITLES = ["hiring manager", "recruiter", "university recruiter", "head of", "director", "vice president", "product manager", "strategy", "chief of staff"];

/** Query providers in order, rank, persist. Unconfigured providers are skipped and reported, not treated as empty results. */
export async function discoverContacts(
  store: Pick<Store, "upsertCompany" | "upsertContact" | "logEvent">, ctx: Ctx,
  company: { name: string; domain: string }, job: JobForRanking, providers: ContactProvider[], limit = 10,
): Promise<{ ranked: RankedContact[]; skipped: string[]; errors: string[] }> {
  const co = await store.upsertCompany(ctx, company.name, company.domain);
  const skipped: string[] = [], errors: string[] = [];
  const seen = new Set<string>(); const all = [];
  for (const p of providers) {
    if (!p.isConfigured()) { skipped.push(p.name); continue; }
    try {
      for (const c of await p.search({ domain: company.domain, companyName: company.name, titles: DEFAULT_TITLES, limit })) {
        const key = (c.email ?? c.linkedinUrl ?? c.name).toLowerCase();
        if (!seen.has(key)) { seen.add(key); all.push(c); }
      }
    } catch (e) { errors.push(`${p.name}: ${(e as Error).message}`); }
  }
  const ranked = rankContacts(all, job).slice(0, limit);
  for (const r of ranked) {
    await store.upsertContact(ctx, { ctx, companyId: co.id, name: r.contact.name, title: r.contact.title, email: r.contact.email,
      linkedinUrl: r.contact.linkedinUrl, relevance: r.score, source: r.contact.source });
  }
  await store.logEvent(ctx, "contacts.discovered", "company", co.id, { count: ranked.length, skipped, errors });
  return { ranked, skipped, errors };
}
