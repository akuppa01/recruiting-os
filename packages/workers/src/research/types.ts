import { z } from "zod";

export const ClaimKind = z.enum(["sourced", "inference", "speculation"]);
export type ClaimKind = z.infer<typeof ClaimKind>;
export const Source = z.object({ url: z.string().url(), retrievedAt: z.string() });
export type Source = z.infer<typeof Source>;

/** A single statement. `sourced` REQUIRES >=1 source; speculation is rendered with an explicit label. */
export const Claim = z.object({
  text: z.string().min(1),
  kind: ClaimKind,
  sources: z.array(Source).default([]),
}).refine((c) => c.kind !== "sourced" || c.sources.length > 0, { message: "sourced claim needs a source" });
export type Claim = z.infer<typeof Claim>;

export const Idea = z.object({
  title: z.string().min(1),
  rationale: z.string().min(1),
  kind: ClaimKind.default("speculation"),
  sources: z.array(Source).default([]),
});
export type Idea = z.infer<typeof Idea>;

export const CompanyResearch = z.object({
  company: z.string(),
  domain: z.string().nullable(),
  generatedAt: z.string(),
  source: z.enum(["stub", "anthropic"]),
  product: z.array(Claim),
  strategy: z.array(Claim),
  market: z.array(Claim),
  news: z.array(Claim),
  competitors: z.array(Claim),
  hiringContext: z.array(Claim),
  businessProblems: z.array(Claim),
  ideas: z.array(Idea),
  disclaimer: z.string(),
});
export type CompanyResearch = z.infer<typeof CompanyResearch>;

export const RESEARCH_DISCLAIMER =
  "Public-source analysis. Items marked INFERENCE or SPECULATION are the author's hypotheses, not internal company data.";

export interface FetchedPage { url: string; status: number; text: string; title?: string; description?: string }
export type Fetcher = (url: string) => Promise<FetchedPage | null>;
