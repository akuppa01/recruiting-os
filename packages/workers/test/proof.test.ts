import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderProofHtml, writeProofPage, loomScript, VercelAdapter, deployPreview, verifyUrl } from "../src/proof/index.js";
import type { CompanyResearch } from "../src/research/index.js";

const src = [{ url: "https://acme.test", retrievedAt: "2026-11-06T00:00:00Z" }];
const sample: CompanyResearch = {
  company: "Acme <Corp>", domain: "acme.test", generatedAt: "2026-11-06T00:00:00Z", source: "anthropic",
  product: [{ text: "Routing for retailers.", kind: "sourced", sources: src }],
  strategy: [{ text: "Likely moving upmarket.", kind: "inference", sources: [] }],
  market: [], news: [], competitors: [],
  hiringContext: [],
  businessProblems: [{ text: "Onboarding may be slow.", kind: "speculation", sources: [] }],
  ideas: [1, 2, 3].map((n) => ({ title: `Idea ${n}`, rationale: `Try thing ${n}`, kind: "speculation" as const, sources: [] })),
  disclaimer: "Public-source analysis. Items marked INFERENCE or SPECULATION are hypotheses.",
};

describe("proof page", () => {
  it("labels every claim, escapes HTML, has footer, is self-contained", () => {
    const { html } = renderProofHtml(sample);
    const claims = html.match(/<li class="claim/g)!.length;
    const badges = html.match(/<li class="claim [a-z]+"><span class="badge/g)!.length;
    expect(claims).toBe(badges);
    expect(html).toContain("SPECULATION");
    expect(html).toContain("INFERENCE");
    expect(html).toContain("Acme &lt;Corp&gt;");
    expect(html).not.toContain("<Corp>");
    expect(html).toContain("publicly available information");
    expect(html).not.toMatch(/<script|<link[^>]+href=|src="http/);
    expect(html).not.toContain("ILLUSTRATIVE"); // no metric section unless supplied
  });
  it("metrics section only when supplied and always labelled", () => {
    const { html } = renderProofHtml(sample, { illustrativeMetrics: [{ label: "Hypothetical lift", value: "+10%" }] });
    expect(html).toContain("ILLUSTRATIVE – NOT COMPANY DATA");
  });
  it("warns on stub research and few ideas; writes file", async () => {
    const r = { ...sample, source: "stub" as const, ideas: sample.ideas.slice(0, 1) };
    const dir = await mkdtemp(join(tmpdir(), "proof-"));
    const out = await writeProofPage(r, {}, dir);
    expect(out.warnings.length).toBe(2);
    expect(await readFile(out.file, "utf8")).toContain("<!doctype html>");
    expect(out.file).toMatch(/acme-corp[\\/]index\.html$/);
  });
  it("loom script has timed beats and speculation caveat", () => {
    const s = loomScript(sample, { candidateName: "Adi" });
    expect(s).toMatch(/\[0:00-0:15\]/);
    expect(s).toMatch(/\[0:35-1:05\] Idea 1/);
    expect(s).toContain("speculation");
  });
});

describe("deploy adapter", () => {
  it("dry_run without token, never a URL", async () => {
    const r = await deployPreview("/x", new VercelAdapter({}));
    expect(r).toMatchObject({ status: "dry_run", url: null, localPath: "/x" });
  });
  it("with token: parsed URL is only 'unverified' until verified", async () => {
    const a = new VercelAdapter({ VERCEL_TOKEN: "tok" }, async () => ({ stdout: "Preview: https://acme-abc.vercel.app\n" }));
    const r = await a.deploy("/x");
    expect(r).toMatchObject({ status: "unverified", url: "https://acme-abc.vercel.app" });
    expect((await verifyUrl(r, (async () => ({ ok: true, status: 200 })) as any)).status).toBe("succeeded");
    expect((await verifyUrl(r, (async () => ({ ok: false, status: 404 })) as any)).status).toBe("unverified");
  });
  it("failure redacts token", async () => {
    const a = new VercelAdapter({ VERCEL_TOKEN: "sekret" }, async () => { throw new Error("bad token sekret"); });
    const r = await a.deploy("/x");
    expect(r.status).toBe("failed");
    expect(r.detail).not.toContain("sekret");
  });
});
