import type { Ctx, Store } from "@ros/core";
import { complete, llmAvailable } from "../llm.js";
import { defaultFetcher } from "./fetcher.js";
import {
  Claim, CompanyResearch, Idea, RESEARCH_DISCLAIMER,
  type Fetcher, type FetchedPage, type Source,
} from "./types.js";

export interface JobContext { title?: string; description?: string; location?: string }
export interface ResearchDeps { fetcher?: Fetcher; now?: () => Date; llm?: typeof complete; llmEnabled?: () => boolean }

const PATHS = ["", "/about", "/company", "/careers", "/blog", "/news"];

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "company";
}

function sentences(t: string, n: number): string[] {
  return t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 40 && s.length < 300).slice(0, n);
}

/** Heuristic (no-LLM) research: only page-derived statements are 'sourced'; everything else is labelled. */
function stubResearch(company: string, pages: FetchedPage[], retrievedAt: string, job?: JobContext) {
  const src = (p: FetchedPage): Source[] => [{ url: p.url, retrievedAt }];
  const home = pages[0];
  const product: Claim[] = [];
  for (const p of pages.slice(0, 3)) {
    if (p.description) product.push({ text: p.description, kind: "sourced", sources: src(p) });
  }
  if (home && !product.length) for (const s of sentences(home.text, 2)) product.push({ text: s, kind: "sourced", sources: src(home) });
  const careers = pages.find((p) => /career|jobs/.test(p.url));
  const hiringContext: Claim[] = [];
  if (careers) hiringContext.push({ text: `Company publishes a careers page (${careers.title ?? careers.url}).`, kind: "sourced", sources: src(careers) });
  if (job?.title) hiringContext.push({ text: `Role under consideration: ${job.title}. Team and headcount context not publicly verified.`, kind: "inference", sources: [] });
  const spec = (text: string): Claim => ({ text, kind: "speculation", sources: [] });
  return {
    product,
    strategy: [spec(`Strategy for ${company} was not derivable from fetched pages without an LLM; to be researched.`)],
    market: [],
    news: [],
    competitors: [],
    hiringContext,
    businessProblems: [spec(`Hypothesis only: growth, onboarding efficiency and go-to-market focus are typical areas where an MBA intern could help ${company}.`)],
    ideas: [{ title: "Discovery-first 30-60-90 outline", rationale: `Speculative: propose a short scoped project for ${company} after confirming priorities in conversation.`, kind: "speculation" as const, sources: [] }],
  };
}

function sanitize(raw: unknown, allowed: Set<string>, retrievedAt: string): Claim[] {
  if (!Array.isArray(raw)) return [];
  const out: Claim[] = [];
  for (const r of raw) {
    const o = r as { text?: string; kind?: string; sources?: Array<string | { url?: string }> };
    if (!o?.text) continue;
    const sources = (o.sources ?? [])
      .map((s) => (typeof s === "string" ? s : s?.url))
      .filter((u): u is string => !!u && allowed.has(u))
      .map((url) => ({ url, retrievedAt }));
    // A claim can only be 'sourced' if it cites a page we actually fetched; otherwise downgrade (never upgrade).
    let kind: "sourced" | "inference" | "speculation" = o.kind === "inference" ? "inference" : o.kind === "sourced" ? "sourced" : "speculation";
    if (kind === "sourced" && sources.length === 0) kind = "speculation";
    out.push({ text: o.text, kind, sources });
  }
  return out;
}

export async function researchCompany(
  store: Pick<Store, "saveCompanyResearch" | "upsertCompany" | "logEvent">,
  ctx: Ctx, companyName: string, domain?: string | null, jobContext?: JobContext, deps: ResearchDeps = {},
): Promise<CompanyResearch> {
  const fetcher = deps.fetcher ?? defaultFetcher;
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const pages: FetchedPage[] = [];
  if (domain) {
    for (const p of PATHS) {
      const page = await fetcher(`https://${domain}${p}`);
      if (page) pages.push(page);
    }
  }
  const useLlm = (deps.llmEnabled ?? llmAvailable)();
  let body: Omit<CompanyResearch, "company" | "domain" | "generatedAt" | "source" | "disclaimer">;
  let source: "stub" | "anthropic" = "stub";
  if (useLlm) {
    const allowed = new Set(pages.map((p) => p.url));
    const prompt = `Research ${companyName} for an MBA internship candidate. Use ONLY the page excerpts below for 'sourced' claims (cite page URLs). Mark anything else 'inference' or 'speculation'. Never present speculation as internal data.
Role context: ${JSON.stringify(jobContext ?? {})}
Pages:\n${pages.map((p) => `URL: ${p.url}\n${p.text.slice(0, 2500)}`).join("\n---\n")}
Return JSON: {"product":[C],"strategy":[C],"market":[C],"news":[C],"competitors":[C],"hiringContext":[C],"businessProblems":[C],"ideas":[{"title","rationale","kind","sources":[url]}]} where C={"text","kind":"sourced|inference|speculation","sources":[url]}. 3-5 ideas.`;
    try {
      const r = await (deps.llm ?? complete)(prompt, { maxTokens: 3000 });
      const json = JSON.parse(r.text.slice(r.text.indexOf("{"), r.text.lastIndexOf("}") + 1));
      const sec = (k: string) => sanitize(json[k], allowed, now);
      body = {
        product: sec("product"), strategy: sec("strategy"), market: sec("market"), news: sec("news"),
        competitors: sec("competitors"), hiringContext: sec("hiringContext"), businessProblems: sec("businessProblems"),
        ideas: (Array.isArray(json.ideas) ? json.ideas : []).slice(0, 5).map((i: { title?: string; rationale?: string; kind?: string; sources?: string[] }) => {
          const [c] = sanitize([{ text: i.rationale ?? "", kind: i.kind, sources: i.sources }], allowed, now);
          return c ? Idea.parse({ title: i.title ?? "Idea", rationale: c.text, kind: c.kind, sources: c.sources }) : null;
        }).filter(Boolean) as Idea[],
      };
      source = r.source;
    } catch (e) {
      await store.logEvent(ctx, "research.llm_failed", "company", null, { company: companyName, error: String(e) });
      body = stubResearch(companyName, pages, now, jobContext);
    }
  } else {
    body = stubResearch(companyName, pages, now, jobContext);
  }
  const research = CompanyResearch.parse({
    company: companyName, domain: domain ?? null, generatedAt: now, source, ...body, disclaimer: RESEARCH_DISCLAIMER,
  });
  const co = await store.upsertCompany(ctx, companyName, domain ?? null);
  await store.saveCompanyResearch(ctx, co.id, research);
  await store.logEvent(ctx, "company.researched", "company", co.id, { source, pages: pages.length });
  return research;
}

/** Pipeline stage: (store, ctx, jobId) => Promise<void> */
export async function runResearchStage(store: Store, ctx: Ctx, jobId: string, deps: ResearchDeps = {}): Promise<void> {
  const job = await store.getJob(ctx, jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  const n = job.normalized;
  await researchCompany(store, ctx, n.company, n.companyDomain, { title: n.title, description: n.description, location: n.location ?? undefined }, deps);
  if (job.stage === "normalized") await store.setJobStage(ctx, jobId, "researched");
}
