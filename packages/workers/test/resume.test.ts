import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvidenceItem } from "@ros/core";
import { normalizeJob } from "../src/normalize/index.js";
import { loadEvidence, selectArchetype, tailorResume, rephraseBullets, verifyBullet, verifyResume, renderResumePdf, runResumeStage } from "../src/resume/index.js";
import { makeFakeStore, ctx } from "./bStore.js";

// ALL SYNTHETIC test data -- not the user's real experience.
const ev = (o: Partial<EvidenceItem> & { id: string; statement: string }): EvidenceItem => ({
  employer: "Testco", role: "Test Engineer", dates: "Jan 2020 – Dec 2021", metrics: [], tags: [], verifiedBy: "user_confirmed", sourceDoc: "synthetic", ...o,
});
const bank: EvidenceItem[] = [
  ev({ id: "e1", statement: "Led CI/CD modernization across 7 teams, cutting release time by 40%.", metrics: ["7 teams", "40%"], tags: ["engineering", "leadership"] }),
  ev({ id: "e2", statement: "Defined product roadmap and launched an AI feature used by 1,200 customers.", metrics: ["1,200 customers"], tags: ["product", "ai"], employer: "Startup Labs", role: "Founder", dates: "May 2025 – Present" }),
  ev({ id: "e3", statement: "Built go-to-market positioning and messaging for SMB outreach.", tags: ["gtm", "marketing"], employer: "Startup Labs", role: "Founder", dates: "May 2025 – Present" }),
];
const pmJob = normalizeJob({ job: { title: "Product Management Intern", company: "Acme", description: "Summer 2027 MBA internship. Own the product roadmap and launch AI features with engineering." } });

describe("evidence loader", () => {
  it("refuses synthetic fixtures by default and validates items", () => {
    const d = mkdtempSync(join(tmpdir(), "ev-"));
    writeFileSync(join(d, "x.synthetic.json"), JSON.stringify([bank[0]]));
    writeFileSync(join(d, "real.json"), JSON.stringify([bank[1], { id: "bad" }]));
    mkdirSync(join(d, "private")); writeFileSync(join(d, "private", "profile.json"), JSON.stringify({ name: "T", email: "t@example.com" }));
    const r = loadEvidence(d);
    expect(r.skippedSynthetic).toHaveLength(1);
    expect(r.items.map((i) => i.id)).toEqual(["e2"]);
    expect(r.errors.join()).toMatch(/bad/);
    expect(r.profile?.name).toBe("T");
    expect(loadEvidence(d, { allowSynthetic: true }).items).toHaveLength(2);
  });
  it("repo example is flagged synthetic and ignored", () => {
    expect(loadEvidence(new URL("../../../resumes/evidence", import.meta.url).pathname).items).toHaveLength(0);
  });
});

describe("tailoring", () => {
  it("selects archetype from role + JD", () => {
    expect(selectArchetype("product_management", "roadmap").archetype).toBe("product_management");
    expect(selectArchetype("product_marketing", "positioning messaging").archetype).toBe("product_marketing");
    expect(selectArchetype("gtm_strategy", "pricing").archetype).toBe("gtm_strategy");
    expect(selectArchetype("founders_office", "ceo").archetype).toBe("founders_office_bizops");
  });
  it("uses only verbatim evidence, ranks relevant first, verifies", () => {
    const t = tailorResume(pmJob, bank);
    expect(t.archetype).toBe("product_management");
    expect(t.factualConfidence).toBe(1);
    const texts = t.contentJson.sections.flatMap((s) => s.bullets.map((b) => b.text));
    for (const x of texts) expect(bank.map((b) => b.statement)).toContain(x);
    const startup = t.contentJson.sections.find((x) => x.employer === "Startup Labs")!;
    expect(startup.bullets[0]!.evidenceId).toBe("e2"); // product/AI bullet outranks the gtm bullet for a PM role within its employer group
    expect(t.verification.ok).toBe(true);
  });
  it("throws on empty bank", () => expect(() => tailorResume(pmJob, [])).toThrow(/empty/));
});

describe("adversarial: fabrication is rejected", () => {
  it("verifyBullet rejects invented metrics, titles, entities", () => {
    expect(verifyBullet("Led CI/CD modernization across 7 teams, cutting release time by 40%.", bank[0]!).ok).toBe(true);
    expect(verifyBullet("Led CI/CD modernization across 12 teams, cutting release time by 40%.", bank[0]!).ok).toBe(false);
    expect(verifyBullet("Led CI/CD modernization across 7 teams, cutting release time by 90%.", bank[0]!).reasons.join()).toMatch(/90%/);
    expect(verifyBullet("Led CI/CD modernization across 7 teams at Google as Director.", bank[0]!).reasons.join()).toMatch(/Google|Director/);
    expect(verifyBullet("Increased revenue by $5M.", bank[0]!).ok).toBe(false);
  });
  it("rephraseBullets keeps verbatim when the rewrite fabricates, accepts a faithful rewrite", async () => {
    const t = tailorResume(pmJob, bank);
    const rewrite = async (s: string) => s.includes("1,200") ? "Launched an AI feature used by 1,200 customers and defined the product roadmap." : s + " Grew ARR 340%.";
    const out = await rephraseBullets(t, bank, pmJob, rewrite);
    expect(out.accepted).toBe(1); expect(out.rejected).toBe(2);
    const texts = out.result.contentJson.sections.flatMap((s) => s.bullets.map((b) => b.text)).join("\n");
    expect(texts).not.toMatch(/340/);
    expect(out.result.verification.ok).toBe(true);
  });
  it("verifyResume catches tampered content and header drift", () => {
    const t = tailorResume(pmJob, bank);
    const tampered = structuredClone(t.contentJson);
    tampered.sections[0]!.bullets[0]!.text = "Increased revenue 340%";
    expect(verifyResume(tampered, bank).ok).toBe(false);
    const drift = structuredClone(t.contentJson); drift.sections[0]!.role = "CEO";
    expect(verifyResume(drift, bank).failures[0]!.reasons.join()).toMatch(/employer\/role\/dates/);
    const unk = structuredClone(t.contentJson); unk.sections[0]!.bullets.push({ evidenceId: "nope", text: "x", rephrased: false });
    expect(verifyResume(unk, bank).ok).toBe(false);
  });
});

describe("pdf + stage", () => {
  it("renders a real, text-bearing single-column PDF", async () => {
    const t = tailorResume(pmJob, bank, undefined, { profile: { name: "Test Person", email: "t@example.com", education: ["Test MBA"] } });
    const pdf = await renderResumePdf(t.contentJson, { compress: false });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    // pdfkit writes standard-font text as hex strings; decode them
    const text = [...pdf.toString("latin1").matchAll(/<([0-9a-f]{2,})>/gi)].map((m) => Buffer.from(m[1]!, "hex").toString("latin1")).join("");
    expect(text).toContain("Startup Labs"); expect(text).toContain("Defined product roadmap"); expect(text).toContain("Test Person");
  });
  it("stage: empty evidence -> exception, no resume", async () => {
    const f = makeFakeStore();
    const i = await f.store.createIngestion(ctx, { source: "manual_text", text: "Product Management Intern at Acme\nSummer 2027 MBA internship" });
    const { runNormalizeStage } = await import("../src/stages/index.js");
    await runNormalizeStage(f.store, ctx, i.id);
    const jobId = f.ings.get(i.id)!.jobId!;
    const empty = mkdtempSync(join(tmpdir(), "ev-"));
    expect(await runResumeStage(f.store, ctx, jobId, { evidenceDir: empty })).toBeNull();
    expect(f.exceptions[0]!.type).toBe("missing_profile_field");
    expect(f.resumes).toHaveLength(0);
  });
  it("stage: with evidence -> resume version saved with confidence and PDF", async () => {
    const f = makeFakeStore();
    const i = await f.store.createIngestion(ctx, { source: "manual_text", text: "Product Management Intern at Acme\nSummer 2027 MBA internship. Own the product roadmap." });
    const { runNormalizeStage } = await import("../src/stages/index.js");
    await runNormalizeStage(f.store, ctx, i.id);
    const jobId = f.ings.get(i.id)!.jobId!;
    const d = mkdtempSync(join(tmpdir(), "ev-")); writeFileSync(join(d, "real.json"), JSON.stringify(bank));
    const r = await runResumeStage(f.store, ctx, jobId, { evidenceDir: d });
    expect(r).not.toBeNull();
    expect(f.resumes[0]!.factualConfidence).toBe(1);
    expect(r!.pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(f.events.some((e) => e.kind === "resume.generated")).toBe(true);
  });
});
