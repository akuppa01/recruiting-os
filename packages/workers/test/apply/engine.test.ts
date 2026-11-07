// V3 apply engine against local MOCK forms (never real company pages). Headless Chromium + a local node server.
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { DEFAULT_LIMITS } from "@ros/core";
import { normalizeJob } from "../../src/normalize/index.js";
import {
  AiBudget, ForbiddenApplicantEmailError, InMemoryFormTemplateStore, applyToJob, draftEssayAnswer, estimateLlmCostUsd, formSignature, interpretQuestion, loadStagehand, resolveApplicantEmail, scanRaw, scrubForbiddenEmails,
  type ApplyDeps, type LlmFn, type StagehandProvider,
} from "../../src/apply/index.js";
import { makeFakeStore, ctx } from "../bStore.js";
import { startFormServer, type FormServer } from "../fixtures/forms/mock-forms.js";

let srv: FormServer, browser: Browser, pdfPath = "";
const T = 90_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  srv = await startFormServer();
  pdfPath = join(mkdtempSync(join(tmpdir(), "res-")), "resume.pdf");
  writeFileSync(pdfPath, "%PDF-1.4 test");
  browser = await chromium.launch({ headless: true });
}, T);
afterAll(async () => { await browser?.close(); await srv?.close(); });

const profile = {
  name: "Test Person", email: "test@example.com", phone: "5550100123", linkedin: "https://linkedin.com/in/test", education: [] as string[],
  eligibility: { requiresSponsorship: false, authorizedToWorkUS: true, gender: "male" as const },
};
const urlFor = (ats: string) =>
  ats === "greenhouse" ? `https://boards.greenhouse.io/acme/jobs/${Math.floor(Math.random() * 1e9)}`
  : ats === "lever" ? `https://jobs.lever.co/acme/${randomUUID()}`
  : `https://jobs.ashbyhq.com/acme/${randomUUID()}`;

interface SetupOpts { ats?: "greenhouse" | "lever" | "ashby"; policy?: Record<string, unknown>; deps?: Partial<ApplyDeps>; store?: ReturnType<typeof makeFakeStore> }
async function setup(fixture: string, o: SetupOpts = {}) {
  const f = o.store ?? makeFakeStore();
  const ats = o.ats ?? "greenhouse";
  await f.store.setPreferences(ctx, { policy: { mode: "dry_run", autoApply: false, ...(o.policy ?? {}) } as any });
  const { job } = await f.store.upsertJob(ctx, `ing-${randomUUID()}`, normalizeJob({ job: { title: "Product Management Intern", company: "Acme", applyUrl: urlFor(ats), description: "Summer 2027 internship" } }));
  const deps: ApplyDeps = {
    profile, resumePdfPath: pdfPath, verifiedAdapters: new Set(),
    openPage: async () => { const p = await (await browser.newContext()).newPage(); await p.goto(`${srv.base}/${fixture}`); return { page: p, close: () => p.context().close() }; },
    ...(o.deps ?? {}),
  };
  return { f, job, deps };
}
const live = { mode: "live", autoApply: true };
const verifiedAll = new Set(["greenhouse", "lever", "ashby"] as const);

describe("mock ATS forms: dry-run never submits, live submits only with confirmation evidence", () => {
  it("Greenhouse-style: dry-run fills comboboxes + resume, no submission, metrics populated", async () => {
    srv.reset();
    const { f, job, deps } = await setup("gh_style");
    const r = await applyToJob(f.store, ctx, job.id, deps);
    expect(r.outcome).toBe("dry_run");
    expect(r.filled).toEqual(expect.arrayContaining(["first_name", "last_name", "email", "resume", "answered: work authorization / sponsorship", "answered: gender / orientation"]));
    await sleep(100); expect(srv.hits()).toBe(0);
    const a = r.attempt!;
    expect(a.strategy).toBe("deterministic"); expect(a.outcome).toBe("dry_run");
    expect(a.seconds).toBeGreaterThan(0); expect(a.modelCalls).toBe(0); expect(a.costUsd).toBe(0);
    expect(a.fieldsFilled).toBe(r.filled.length); expect(a.fieldsExpected).toBeGreaterThanOrEqual(a.fieldsFilled);
    expect(a.pages).toBe(1); expect(a.templateSignature).toMatch(/^[0-9a-f]{16}$/);
  }, T);

  it.each([
    ["Greenhouse-style", "gh_style", "greenhouse"],
    ["Lever-style", "lever_style", "lever"],
    ["Ashby-style", "ashby_style", "ashby"],
  ] as const)("%s: live + verified => submitted with confirmation evidence; second call is idempotent", async (_n, fixture, ats) => {
    srv.reset();
    const { f, job, deps } = await setup(fixture, { ats, policy: live, deps: { verifiedAdapters: new Set([ats]) } });
    const r = await applyToJob(f.store, ctx, job.id, deps);
    expect(r.outcome).toBe("submitted_confirmed"); expect(r.result.confirmed).toBe(true);
    expect(r.result.confirmationEvidence?.kind).toBe("confirmation_page_text");
    expect(srv.hits()).toBe(1);
    expect((await f.store.getJob(ctx, job.id))!.stage).toBe("applied");
    expect(r.attempt!.outcome).toBe("submitted_confirmed");
    const again = await applyToJob(f.store, ctx, job.id, deps);
    expect(again.outcome).toBe("already_applied"); await sleep(100); expect(srv.hits()).toBe(1);
  }, T);

  it("multipage: navigates Next, fills page 2, submits once on the final page", async () => {
    srv.reset();
    const dry = await setup("multipage");
    const d = await applyToJob(dry.f.store, ctx, dry.job.id, dry.deps);
    expect(d.outcome).toBe("dry_run"); expect(d.attempt!.pages).toBe(2);
    expect(d.filled).toEqual(expect.arrayContaining(["first_name", "email", "resume", "linkedin"]));
    await sleep(100); expect(srv.hits()).toBe(0);
    const lv = await setup("multipage", { policy: live, deps: { verifiedAdapters: new Set(["greenhouse"]) } });
    const r = await applyToJob(lv.f.store, ctx, lv.job.id, lv.deps);
    expect(r.outcome).toBe("submitted_confirmed"); expect(srv.hits()).toBe(1); expect(r.attempt!.pages).toBe(2);
  }, T);

  it("resume upload through an Attach button: the browser really holds the file", async () => {
    let shown = "";
    const { f, job, deps } = await setup("resume_upload", { deps: { afterFill: async (page: Page) => { shown = await page.locator("#fname").innerText(); } } });
    const r = await applyToJob(f.store, ctx, job.id, deps);
    expect(r.filled).toContain("resume"); expect(shown).toBe("resume.pdf");
  }, T);

  it("validation failure after submit: NOT applied, specific exception naming the field, retry allowed (not 'unverified')", async () => {
    srv.reset();
    const { f, job, deps } = await setup("validation_fail", { policy: live, deps: { verifiedAdapters: new Set(["greenhouse"]), profile: { ...profile, phone: "555-0100" } } });
    const r = await applyToJob(f.store, ctx, job.id, deps);
    expect(r.outcome).toBe("blocked"); expect(r.result.confirmed).toBe(false);
    expect(srv.hits()).toBe(0);
    expect(f.exceptions.at(-1)!.detail).toMatch(/rejected by the form's validation/i);
    expect(f.exceptions.at(-1)!.detail).toMatch(/phone/i);
    expect((await f.store.getApplicationByJob(ctx, job.id))!.status).toBe("failed");
    expect((await f.store.getJob(ctx, job.id))!.stage).not.toBe("applied");
    const again = await applyToJob(f.store, ctx, job.id, deps); // a rejected form was never submitted, so retrying is allowed
    expect(again.outcome).toBe("blocked"); expect(f.exceptions.map((e) => e.type)).not.toContain("submission_unverified");
  }, T);

  it("required sensitive question with no saved answer => exception and no model call", async () => {
    let calls = 0; const llm: LlmFn = async () => { calls++; return { text: "{}", source: "anthropic" }; };
    srv.reset();
    const { f, job, deps } = await setup("disability_required", { policy: live, deps: { verifiedAdapters: new Set(["greenhouse"]), llm } });
    const r = await applyToJob(f.store, ctx, job.id, deps);
    expect(r.outcome).toBe("blocked"); expect(f.exceptions.map((e) => e.type)).toContain("sensitive_eligibility_question");
    expect(calls).toBe(0); expect(srv.hits()).toBe(0); expect(r.attempt!.modelCalls).toBe(0);
  }, T);

  it("maxBrowserSeconds is enforced", async () => {
    srv.reset();
    const { f, job, deps } = await setup("multipage", { deps: { limits: { ...DEFAULT_LIMITS, maxBrowserSeconds: 0.001 } } });
    const r = await applyToJob(f.store, ctx, job.id, deps);
    expect(r.outcome).toBe("blocked"); expect(f.exceptions.at(-1)!.detail).toMatch(/runtime limit/i);
  }, T);
});

describe("form memory (templates)", () => {
  it("2nd application on the same form skips re-classification and records stats", async () => {
    const templates = new InMemoryFormTemplateStore();
    const a = await setup("gh_style", { deps: { templates } });
    const r1 = await applyToJob(a.f.store, ctx, a.job.id, a.deps);
    const b = await setup("gh_style", { deps: { templates } });
    const r2 = await applyToJob(b.f.store, ctx, b.job.id, b.deps);
    expect(r1.attempt!.templateHit).toBe(false); expect(r1.attempt!.classifyCalls).toBeGreaterThan(0);
    expect(r2.attempt!.templateHit).toBe(true); expect(r2.attempt!.classifyCalls).toBe(0);
    expect(r2.attempt!.templateSignature).toBe(r1.attempt!.templateSignature);
    expect(r2.filled.sort()).toEqual(r1.filled.sort()); // same result, less work
    const t = await templates.get("greenhouse", r1.attempt!.templateSignature!);
    expect(t!.successCount).toBe(2); expect(t!.fieldMap.length).toBeGreaterThan(5);
    expect(JSON.stringify(t)).not.toMatch(/test@example\.com|Test Person|5550100123/); // templates never hold applicant answers
  }, T);

  it("a rejected live submit increments the template's failure count", async () => {
    const templates = new InMemoryFormTemplateStore();
    const a = await setup("validation_fail", { deps: { templates, profile: { ...profile, phone: "5550100123" } } });
    const ok = await applyToJob(a.f.store, ctx, a.job.id, a.deps); // dry-run learns the form
    const b = await setup("validation_fail", { policy: live, deps: { templates, verifiedAdapters: new Set(["greenhouse"]), profile: { ...profile, phone: "555" } } });
    await applyToJob(b.f.store, ctx, b.job.id, b.deps);
    const t = await templates.get("greenhouse", ok.attempt!.templateSignature!);
    expect(t!.successCount).toBe(1); expect(t!.failureCount).toBe(1);
  }, T);

  it("a template from an older classifier version is not reused", async () => {
    const templates = new InMemoryFormTemplateStore();
    const a = await setup("gh_style", { deps: { templates } });
    const r1 = await applyToJob(a.f.store, ctx, a.job.id, a.deps);
    const key = `greenhouse:${r1.attempt!.templateSignature}`;
    templates.rows.set(key, { ...templates.rows.get(key)!, version: 0 });
    const b = await setup("gh_style", { deps: { templates } });
    const r2 = await applyToJob(b.f.store, ctx, b.job.id, b.deps);
    expect(r2.attempt!.templateHit).toBe(false); expect(r2.attempt!.classifyCalls).toBeGreaterThan(0);
  }, T);

  it("form signature ignores field order but not structure", async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${srv.base}/gh_style`);
    const raw = await scanRaw(page);
    expect(formSignature(raw)).toBe(formSignature([...raw].reverse()));
    expect(formSignature(raw)).not.toBe(formSignature(raw.slice(1)));
    await page.context().close();
  }, T);
});

describe("fallback strategies (question interpretation, Stagehand, budgets)", () => {
  const rules = [{ match: "commut|in-office|hybrid", text: "Yes" }];
  const pick0: LlmFn = async () => ({ text: '{"ruleIndex":0,"needsHuman":false}', source: "anthropic" });

  it("unfamiliar question: a small model maps it to a SAVED answer; the form is still filled deterministically", async () => {
    let calls = 0; const llm: LlmFn = async (p, o) => { calls++; return pick0(p, o); };
    srv.reset();
    const { f, job, deps } = await setup("unknown_custom", { deps: { llm, profile: { ...profile, answers: rules } } });
    const r = await applyToJob(f.store, ctx, job.id, deps);
    expect(r.outcome).toBe("dry_run"); expect(calls).toBe(1);
    expect(r.attempt!.modelCalls).toBe(1); expect(r.attempt!.costUsd).toBeGreaterThan(0); expect(r.attempt!.costUsd).toBeLessThanOrEqual(DEFAULT_LIMITS.perApplicationAiUsd);
    expect(r.attempt!.strategy).toBe("deterministic"); expect(r.attempt!.fallbackAttempts).toBe(1);
  }, T);

  it("per-application AI budget exhausted => no model call, exception instead", async () => {
    let calls = 0; const llm: LlmFn = async (p, o) => { calls++; return pick0(p, o); };
    const { f, job, deps } = await setup("unknown_custom", { deps: { llm, profile: { ...profile, answers: rules }, limits: { ...DEFAULT_LIMITS, perApplicationAiUsd: 1e-12 } } });
    const r = await applyToJob(f.store, ctx, job.id, deps);
    expect(r.outcome).toBe("blocked"); expect(calls).toBe(0); expect(f.exceptions.at(-1)!.type).toBe("missing_profile_field");
  }, T);

  it("model says needs-human / returns garbage => exception, nothing guessed", async () => {
    for (const text of ['{"ruleIndex":null,"needsHuman":true}', "not json at all", '{"ruleIndex":7,"needsHuman":false}']) {
      const llm: LlmFn = async () => ({ text, source: "anthropic" });
      const { f, job, deps } = await setup("unknown_custom", { deps: { llm, profile: { ...profile, answers: rules } } });
      const r = await applyToJob(f.store, ctx, job.id, deps);
      expect(r.outcome).toBe("blocked"); expect(f.exceptions.at(-1)!.detail).toMatch(/on site three days/i);
    }
  }, T);

  it("Stagehand operates a control the deterministic flow cannot; strategy is reported and attempts are capped", async () => {
    const stagehand: StagehandProvider = async (page) => ({
      ok: true,
      sh: { act: async () => { await page.evaluate(() => { const i = document.getElementById("oc") as HTMLInputElement; i.removeAttribute("readonly"); i.value = "Yes"; }); } },
    });
    const one = await setup("custom_widget", { deps: { llm: pick0, stagehand, profile: { ...profile, answers: rules } } });
    const r = await applyToJob(one.f.store, ctx, one.job.id, one.deps);
    expect(r.outcome).toBe("dry_run"); expect(r.attempt!.strategy).toBe("stagehand");
    expect(r.attempt!.modelCalls).toBe(2); expect(r.attempt!.costUsd).toBeLessThanOrEqual(DEFAULT_LIMITS.perApplicationAiUsd);

    const capped = await setup("custom_widget", { deps: { llm: pick0, stagehand, profile: { ...profile, answers: rules }, limits: { ...DEFAULT_LIMITS, maxFallbackAttempts: 1 } } });
    const c = await applyToJob(capped.f.store, ctx, capped.job.id, capped.deps);
    expect(c.outcome).toBe("blocked"); expect(c.attempt!.fallbackAttempts).toBe(1); // interpretation used the only attempt
  }, T);

  it("tertiary agent recovery is unsupported by default; Stagehand absent => clear 'not installed' result", async () => {
    const r = await loadStagehand(null as unknown as Page);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toMatch(/not installed/i);
    const { f, job, deps } = await setup("custom_widget", { deps: { llm: pick0, profile: { ...profile, answers: rules } } });
    expect((await applyToJob(f.store, ctx, job.id, deps)).outcome).toBe("blocked");
  }, T);
});

describe("strategy helpers", () => {
  it("interpretQuestion never sends sensitive questions to a model", async () => {
    let calls = 0; const llm: LlmFn = async () => { calls++; return { text: "{}", source: "anthropic" }; };
    const b = new AiBudget();
    const r = await interpretQuestion({ question: "Do you require visa sponsorship?" }, [{ match: "x", text: "No" }], { budget: b, llm });
    expect(r).toMatchObject({ action: "needs_human" }); expect(calls).toBe(0); expect(b.calls).toBe(0);
  });
  it("AiBudget enforces attempts and dollars; cost estimate is positive and scales with size", () => {
    const b = new AiBudget({ ...DEFAULT_LIMITS, maxFallbackAttempts: 2, perApplicationAiUsd: 0.01 });
    expect(b.canAttempt(0.005)).toBe(true); b.attempt(0.006); expect(b.canAttempt(0.005)).toBe(false); // would exceed dollars
    expect(b.canAttempt(0.001)).toBe(true); b.attempt(0.001); expect(b.canAttempt(0)).toBe(false); // attempts used up
    expect(estimateLlmCostUsd(4000, 200)).toBeGreaterThan(estimateLlmCostUsd(400, 20));
    expect(new AiBudget(DEFAULT_LIMITS, 0.001).limitUsd).toBe(0.001); // remaining daily allowance caps the per-application budget
  });
});

describe("applicant identity: the business address (@asvagroup.org) is never used", () => {
  const tepper = "akuppa@tepper.cmu.edu";
  it("application_profile.email wins; the resume header is only a fallback; the business address is refused from either source", () => {
    expect(resolveApplicantEmail(tepper, "someone@asvagroup.org")).toBe(tepper);
    expect(resolveApplicantEmail(undefined, "header@example.edu")).toBe("header@example.edu");
    expect(resolveApplicantEmail("  ", "header@example.edu")).toBe("header@example.edu");
    expect(() => resolveApplicantEmail("a@asvagroup.org", "b@example.edu")).toThrow(ForbiddenApplicantEmailError);
    expect(() => resolveApplicantEmail(undefined, "Aditya.Kuppa@ASVAGROUP.ORG ")).toThrow(/business address/);
    expect(() => resolveApplicantEmail(undefined, undefined)).toThrow(/No applicant email/);
  });

  it("applyToJob refuses before opening any browser when the profile email is the business address", async () => {
    srv.reset(); let opened = false;
    const { f, job, deps } = await setup("gh_style", { policy: live, deps: { verifiedAdapters: new Set(["greenhouse"]), profile: { ...profile, email: "x@AsvaGroup.org " }, openPage: async () => { opened = true; throw new Error("must not open"); } } });
    const r = await applyToJob(f.store, ctx, job.id, deps);
    expect(r.outcome).toBe("blocked"); expect(opened).toBe(false); expect(srv.hits()).toBe(0);
    expect(f.exceptions.at(-1)!.detail).toMatch(/asvagroup/i);
  }, T);

  it("no field of a filled form ever contains the business address (Tepper address is what gets filled)", async () => {
    const seen: string[] = [];
    const { f, job, deps } = await setup("gh_style", { deps: { profile: { ...profile, email: tepper }, afterFill: async (page: Page) => {
      seen.push(...(await page.evaluate(() => Array.from(document.querySelectorAll("input, textarea, select")).map((e) => (e as HTMLInputElement).value))));
    } } });
    const r = await applyToJob(f.store, ctx, job.id, deps);
    expect(r.outcome).toBe("dry_run");
    expect(seen).toContain(tepper); expect(seen.join("\n").toLowerCase()).not.toContain("asvagroup");
  }, T);

  it("essay drafting never shows the model, or returns, the business address", async () => {
    expect(scrubForbiddenEmails("Contact: 972-742-4637 aditya.kuppa@asvagroup.org Pittsburgh")).not.toMatch(/asvagroup/);
    const prompts: string[] = [];
    let n = 0;
    const llm = async (prompt: string) => { prompts.push(prompt); n++; return { text: n === 1 ? "Reach me at aditya@asvagroup.org about Casuro.ai." : "I led GTM at Casuro.ai.", source: "anthropic" as const }; };
    const out = await draftEssayAnswer({ question: "Why us?", company: "Acme", title: "PM Intern", description: "x", about: "Contact aditya.kuppa@asvagroup.org\nCasuro.ai GTM" }, llm);
    expect(out).toBe("I led GTM at Casuro.ai."); expect(n).toBe(2);
    expect(prompts[0]).not.toMatch(/asvagroup/i);
    const never = await draftEssayAnswer({ question: "Why us?", company: "Acme", title: "PM Intern", description: "x", about: "Casuro.ai" }, async () => ({ text: "mail me at a@asvagroup.org", source: "anthropic" as const }));
    expect(never).toBeNull(); // always contained the address => left for the user
  }, T);
});
