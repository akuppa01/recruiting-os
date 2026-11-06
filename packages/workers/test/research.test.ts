import { describe, it, expect } from "vitest";
import { researchCompany, CompanyResearch, type Fetcher } from "../src/research/index.js";
import { makeFake, ctx } from "./fakeStore.js";

const fixture: Fetcher = async (url) =>
  url === "https://acme.test" ? { url, status: 200, text: "Acme builds widgets for logistics teams around the world.", title: "Acme", description: "Acme automates warehouse routing for mid-market retailers." }
  : url === "https://acme.test/careers" ? { url, status: 200, text: "Join us", title: "Careers at Acme" } : null;

describe("researchCompany (stub path)", () => {
  it("labels claims, persists, only sources fetched URLs", async () => {
    const f = makeFake();
    const r = await researchCompany(f.store, ctx, "Acme", "acme.test", { title: "PM Intern" }, { fetcher: fixture, llmEnabled: () => false, now: () => new Date("2026-11-06T00:00:00Z") });
    expect(r.source).toBe("stub");
    expect(CompanyResearch.safeParse(r).success).toBe(true);
    expect(r.product[0]).toMatchObject({ kind: "sourced" });
    expect(r.product[0]!.sources[0]!.url).toBe("https://acme.test");
    expect([...r.strategy, ...r.businessProblems, ...r.ideas].every((c) => c.kind !== "sourced")).toBe(true);
    expect([...f.companies.values()][0].research).toBeTruthy();
  });
  it("downgrades LLM 'sourced' claims that cite unfetched URLs", async () => {
    const f = makeFake();
    const llm = async () => ({ source: "anthropic" as const, text: JSON.stringify({
      product: [{ text: "Fake", kind: "sourced", sources: ["https://evil.test/x"] }, { text: "Real", kind: "sourced", sources: ["https://acme.test"] }],
      strategy: [], market: [], news: [], competitors: [], hiringContext: [], businessProblems: [],
      ideas: [{ title: "I", rationale: "r", kind: "sourced", sources: [] }] }) });
    const r = await researchCompany(f.store, ctx, "Acme", "acme.test", undefined, { fetcher: fixture, llmEnabled: () => true, llm });
    expect(r.product.find((c) => c.text === "Fake")!.kind).toBe("speculation");
    expect(r.product.find((c) => c.text === "Real")!.kind).toBe("sourced");
    expect(r.ideas[0]!.kind).toBe("speculation");
  });
});
