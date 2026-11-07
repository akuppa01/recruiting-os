import type { Page } from "playwright";
import { ApplicationAttemptResult, AutomationPolicy, type AtsKind, type Ctx, type ExceptionType, type Store } from "@ros/core";
import type { CandidateProfile } from "../resume/evidence.js";
import { ADAPTERS, detectConfirmation, type AtsAdapter } from "./adapters.js";
import { detectBlockers, pageText, scanForm } from "./browser.js";
import { splitName, type FieldKey } from "./fields.js";
import { wantedAnswer, type Wanted } from "./answers.js";
import type { ScannedField } from "./browser.js";

export * from "./adapters.js";
export * from "./essays.js";
export * from "./fields.js";
export { scanForm, detectBlockers } from "./browser.js";

export interface OpenedPage { page: Page; close: () => Promise<void> }
export interface ApplyDeps {
  profile: CandidateProfile;
  resumePdfPath: string;
  coverLetter?: string;
  resumeVersionId?: string | null;
  /** adapters proven in supervised real-world runs; default empty => live submit is never attempted */
  verifiedAdapters?: Set<AtsKind>;
  openPage?: (url: string) => Promise<OpenedPage>;
  /** Draft text for a free-text question. approved=false keeps the draft for the user's review instead of filling it. */
  draftEssay?: (q: { question: string; company: string; title: string; description: string; aiRestricted: boolean }) => Promise<{ text: string; approved: boolean } | null>;
  /** Leave the browser window open after filling so a human can review, finish and submit it. */
  keepOpen?: boolean;
  /** Called when a visible CAPTCHA appears. Return true once a human has solved it. Never solved automatically. */
  onCaptcha?: (page: Page) => Promise<boolean>;
  /** Called once the form has been filled (before any submit decision), e.g. to save a screenshot. */
  afterFill?: (page: Page, info: { filled: string[] }) => Promise<void>;
  /** Last gate before a live submit click. Return false to leave the form filled but unsubmitted. */
  beforeSubmit?: (info: { company: string; title: string; url: string; filled: string[] }) => Promise<boolean>;
}

export type ApplyOutcome = "already_applied" | "dry_run" | "submitted_confirmed" | "submitted_unverified" | "blocked" | "unsupported" | "live_gated";
export interface ApplyReport { outcome: ApplyOutcome; result: ApplicationAttemptResult; filled: string[]; applicationId?: string }

/** Company career pages often embed the ATS form in an iframe. Scanning only sees the top document, so open the embedded form directly. */
async function hopToEmbeddedForm(page: Page): Promise<void> {
  const findSrc = () => page.evaluate(() => {
    const f = Array.from(document.querySelectorAll("iframe")).find((i) => /greenhouse\.io|lever\.co|ashbyhq\.com/.test(i.src));
    return f ? f.src : null;
  });
  let src = await findSrc();
  if (!src) {
    await page.waitForSelector("iframe[src*='greenhouse'], iframe[src*='lever.co'], iframe[src*='ashbyhq']", { timeout: 8000 }).catch(() => undefined);
    src = await findSrc();
  }
  if (!src) return;
  await page.goto(src, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const launched: Array<{ isConnected(): boolean }> = [];
/** Resolves once every browser window opened by defaultOpenPage has been closed (used to keep filled forms open for the user). */
export async function waitForBrowsersClosed(): Promise<void> {
  while (launched.some((b) => b.isConnected())) await new Promise((r) => setTimeout(r, 2000));
}

export async function defaultOpenPage(url: string): Promise<OpenedPage> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: process.env.ROS_HEADED !== "1" });
  launched.push(browser);
  const page = await (await browser.newContext()).newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(1500); // let client-side rendering settle before the form is scanned
  return { page, close: () => browser.close() };
}


/** Fill a yes/no style question from a saved answer. Returns false when no control could be matched. */
async function answerField(page: Page, f: ScannedField, want: Wanted, all: ScannedField[]): Promise<boolean> {
  const loc = page.locator(f.selector);
  if (f.tag === "select") {
    const label = f.options.find((o) => want.pick.test(o));
    if (!label) return false;
    await loc.selectOption({ label }); return true;
  }
  if (f.type === "radio") {
    const mate = all.find((o) => o.type === "radio" && o.name === f.name && want.pick.test(o.label));
    if (!mate) return false;
    await page.locator(mate.selector).check({ force: true }); return true;
  }
  if (f.type === "checkbox") {
    if (!want.pick.test(f.label)) return false;
    await loc.check({ force: true, timeout: 5000 }); return true;
  }
  if (f.combo) {
    // Open the dropdown and click the option whose text matches; many of these dropdowns expose no option roles, so fall back to typing.
    const OPT = '[role="option"], [id*="-option-"], [class*="__option"]';
    const choose = async (): Promise<boolean> => {
      const opts = page.locator(OPT);
      const n = await opts.count();
      for (let i = 0; i < n; i++) {
        const t = (await opts.nth(i).innerText()).trim();
        if (want.pick.test(t)) { await opts.nth(i).click(); return true; }
      }
      return false;
    };
    try {
      await loc.click({ timeout: 5000 });
      await page.waitForTimeout(500);
      if (await choose()) return true;
      await loc.fill(want.text); // typeahead lists (e.g. School) only show matches after typing
      await page.waitForTimeout(700);
      if (await choose()) return true;
      if ((await page.locator(OPT).count()) === 0) {
        // Options not detectable: Enter picks the first filtered match. Confirm the control now shows the chosen text.
        await page.keyboard.press("Enter");
        await page.waitForTimeout(300);
        const shown = await loc.evaluate((el) => (el.closest("[class*='container'], [class*='select']") as HTMLElement | null)?.innerText ?? "");
        if (shown.toLowerCase().includes(want.text.toLowerCase().slice(0, 6)) && !/no options/i.test(shown)) return true;
      }
    } catch { /* could not operate this dropdown */ }
    await page.keyboard.press("Escape").catch(() => undefined);
    return false;
  }
  await loc.fill(want.text); return true;
}

const valueFor = (key: FieldKey, p: CandidateProfile, cover?: string): string | null => {
  const n = splitName(p.name);
  switch (key) {
    case "first_name": return n.first; case "last_name": return n.last; case "full_name": return p.name;
    case "email": return p.email; case "phone": return p.phone ?? null; case "linkedin": return p.linkedin ?? null;
    case "website": return p.website ?? null; case "location": return p.location ?? null;
    case "cover_letter_text": return cover ?? null; default: return null;
  }
};

/**
 * Prepare (and, only when fully authorized + verified, submit) one application.
 * Guarantees: idempotent per (tenant, job); never submits in dry_run; never bypasses CAPTCHA/auth;
 * never answers sensitive eligibility questions; marks Submitted only with confirmation evidence.
 */
export async function applyToJob(store: Store, ctx: Ctx, jobId: string, deps: ApplyDeps): Promise<ApplyReport> {
  const job = await store.getJob(ctx, jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  const policy = AutomationPolicy.parse((await store.getPreferences(ctx)).policy);
  const { app } = await store.getOrCreateApplication(ctx, jobId);
  const mk = (status: ApplicationAttemptResult["status"], confirmed = false, exception: ApplicationAttemptResult["exception"] = null, ev: ApplicationAttemptResult["confirmationEvidence"] = null) =>
    ApplicationAttemptResult.parse({ status, confirmed, exception, confirmationEvidence: ev });
  const raise = async (type: ExceptionType, detail: string) => { await store.raiseException(ctx, { ctx, type, entityType: "application", entityId: app.id, detail }); };

  if (app.confirmed) {
    await store.logEvent(ctx, "application.duplicate_skipped", "application", app.id, { jobId });
    return { outcome: "already_applied", result: mk("succeeded", true, null, app.evidence as any), filled: [], applicationId: app.id };
  }
  const liveRequested = policy.mode === "live" && policy.autoApply;
  if (liveRequested && app.status === "unverified") {
    // a prior live attempt may have gone through; resubmitting could create a duplicate application
    await raise("submission_unverified", "Previous live submission is unverified; refusing to resubmit. Check the confirmation email/portal and resolve manually.");
    return { outcome: "blocked", result: mk("unverified", false, { type: "submission_unverified", detail: "prior attempt unverified" }), filled: [], applicationId: app.id };
  }

  const adapter: AtsAdapter | undefined = ADAPTERS[job.normalized.atsKind];
  const applyUrl = job.normalized.applyUrl;
  if (!adapter || !applyUrl) {
    await raise("other", `No supported application adapter for ATS "${job.normalized.atsKind}" (or no apply URL). Apply manually.`);
    await store.setJobStage(ctx, jobId, "needs_human");
    return { outcome: "unsupported", result: mk("failed", false, { type: "other", detail: "unsupported ATS" }), filled: [], applicationId: app.id };
  }

  await store.updateApplication(ctx, app.id, { attempts: app.attempts + 1, status: "pending", resumeVersionId: deps.resumeVersionId ?? app.resumeVersionId });
  const opened = await (deps.openPage ?? defaultOpenPage)(adapter.formUrl(applyUrl));
  const { page } = opened;
  try {
    await hopToEmbeddedForm(page);
    let blockers = await detectBlockers(page);
    if (blockers.captcha && !blockers.authWall && deps.onCaptcha && (await deps.onCaptcha(page))) blockers = await detectBlockers(page);
    if (blockers.captcha || blockers.authWall) {
      const type: ExceptionType = blockers.captcha ? "captcha" : "auth_required";
      await raise(type, `${blockers.details.join("; ")} at ${page.url()}. Complete this application manually.`);
      await store.updateApplication(ctx, app.id, { status: "failed", lastError: type });
      await store.setJobStage(ctx, jobId, "needs_human");
      await store.recordExternalAction(ctx, { system: `ats:${adapter.kind}`, action: "prepare_application", status: "failed", entityId: app.id, detail: type });
      return { outcome: "blocked", result: mk("failed", false, { type, detail: blockers.details.join("; ") }), filled: [], applicationId: app.id };
    }

    const fields = await scanForm(page);
    if (fields.length === 0) {
      await raise("other", `No application form was found at ${page.url()}. Apply manually from the job page.`);
      await store.updateApplication(ctx, app.id, { status: "failed", lastError: "no_form_found" });
      await store.setJobStage(ctx, jobId, "needs_human");
      return { outcome: "blocked", result: mk("failed", false, { type: "other", detail: "no application form found" }), filled: [], applicationId: app.id };
    }
    const filled: string[] = [], sensitive: string[] = [], missing: string[] = [];
    const answered = new Set<string>();
    const deferred: Array<{ f: ScannedField; rule: { match: string; text: string; pick?: string } }> = [];
    const boxes: ScannedField[] = [];
    const answeredBoxGroups = new Set<string>();
    const aiRestricted = /ai policy|ai partnership|guidelines for candidates|do not use ai|without (the use of )?ai|generative ai/i.test(await pageText(page));
    for (const f of fields) {
      if (f.cls.kind === "sensitive") {
        const key = `${f.type === "radio" ? "g:" + f.name : f.selector}`;
        if (answered.has(key)) continue;
        const want = wantedAnswer(f.cls.topic, f.group || f.label, deps.profile.eligibility);
        if (want && (await answerField(page, f, want, fields).catch(() => false))) { answered.add(key); filled.push(`answered: ${f.cls.topic}`); continue; }
        if (f.required) sensitive.push(`${f.cls.topic}: "${f.group || f.label}"`);
        continue;
      }
      if (f.cls.kind === "ack") {
        try {
          if (f.type === "checkbox") await page.locator(f.selector).check({ force: true, timeout: 5000 });
          else if (!(await answerField(page, f, { text: "Yes", pick: /^\s*(yes|i (acknowledge|confirm|agree|understand))\b/i }, fields))) throw new Error("no matching option");
          filled.push(`acknowledged: ${(f.group || f.label).slice(0, 40)}`);
        } catch { if (f.required) missing.push(f.group || f.label); }
        continue;
      }
      if (f.cls.kind === "essay") {
        if (!deps.draftEssay) { if (f.required) missing.push(f.label); continue; }
        try {
          const r = await deps.draftEssay({ question: f.label, company: job.normalized.company, title: job.normalized.title, description: job.normalized.description, aiRestricted });
          if (r?.approved && r.text) { await page.locator(f.selector).fill(r.text, { timeout: 8000 }); filled.push(`essay: ${f.label.slice(0, 40)}`); }
          else if (f.required) missing.push(`${f.label} (draft saved for your review${aiRestricted ? "; this application restricts AI-written answers, so write your own" : ""})`);
        } catch { if (f.required) missing.push(f.label); }
        continue;
      }
      if (f.cls.kind === "unknown") {
        const q = f.group || f.label;
        const rule = (deps.profile.answers ?? []).find((r) => new RegExp(r.match, "i").test(q) || (f.type === "checkbox" && new RegExp(r.match, "i").test(f.label)));
        if (rule) { deferred.push({ f, rule }); continue; } // saved-answer rules run after the core answers so dropdowns don't interfere
        if (f.type === "checkbox") { boxes.push(f); continue; } // required-ness is per group: decided after the saved answers ran
        if (f.required) missing.push(f.label || f.name);
        continue;
      }
      const loc = page.locator(f.selector);
      try {
        if (f.cls.key === "resume") { await loc.setInputFiles(deps.resumePdfPath, { timeout: 10000 }); filled.push("resume"); continue; }
        if (f.cls.key === "cover_letter_file") continue;
        const v = valueFor(f.cls.key, deps.profile, deps.coverLetter);
        if (v == null || v === "") { if (f.required) missing.push(`${f.cls.key} (no value in profile)`); continue; }
        await loc.fill(v, { timeout: 8000 }); filled.push(f.cls.key);
      } catch {
        if (f.required) missing.push(`${f.cls.key} (could not fill "${f.label}")`);
      }
    }
    for (const { f, rule } of deferred) {
      const q = f.group || f.label;
      const key = f.type === "radio" || f.type === "checkbox" ? `g:${q}` : f.selector;
      const want: Wanted = { text: rule.text, pick: new RegExp(rule.pick ?? escapeRe(rule.text), "i") };
      const ok = await answerField(page, f, want, fields).catch(() => false);
      if (ok) { answered.add(key); if (f.type === "checkbox") answeredBoxGroups.add(f.name); filled.push(`answered: ${q.slice(0, 40)}`); continue; }
      if (f.type === "checkbox") { boxes.push(f); continue; }
      if (f.required) missing.push(f.label || f.name);
    }
    for (const f of boxes) {
      if (answeredBoxGroups.has(f.name)) continue; // another box in this group was chosen by a saved answer; leave the rest unchecked
      if (f.required) missing.push(f.group || f.label);
    }
    // Some questions only appear after another is answered (e.g. race after Hispanic/Latino): scan once more for those.
    if (answered.size) {
      const again = await scanForm(page);
      for (const f of again) {
        if (f.cls.kind !== "sensitive") continue;
        const key = f.type === "radio" ? `g:${f.name}` : f.selector;
        if (answered.has(key)) continue;
        const want = wantedAnswer(f.cls.topic, f.group || f.label, deps.profile.eligibility);
        if (want && (await answerField(page, f, want, again).catch(() => false))) { answered.add(key); filled.push(`answered: ${f.cls.topic}`); }
        else if (f.required && !sensitive.some((x) => x.includes(f.group || f.label))) sensitive.push(`${f.cls.topic}: "${f.group || f.label}"`);
      }
    }
    if (filled.length === 0) {
      await raise("other", `Found a page at ${page.url()} but could not fill any application field. Apply manually from the job page.`);
      await store.updateApplication(ctx, app.id, { status: "failed", lastError: "nothing_filled" });
      await store.setJobStage(ctx, jobId, "needs_human");
      return { outcome: "blocked", result: mk("failed", false, { type: "other", detail: "no application fields could be filled" }), filled: [], applicationId: app.id };
    }
    await deps.afterFill?.(page, { filled }).catch(() => undefined);
    if (sensitive.length) {
      await raise("sensitive_eligibility_question", `Required eligibility/EEO question(s) need your own answer: ${sensitive.join("; ")}`);
    }
    if (missing.length) {
      await raise("missing_profile_field", `Required field(s) with no known answer: ${missing.join("; ")}`);
    }
    if (sensitive.length || missing.length) {
      await store.updateApplication(ctx, app.id, { status: "failed", lastError: "needs_human_input" });
      await store.setJobStage(ctx, jobId, "needs_human");
      await store.recordExternalAction(ctx, { system: `ats:${adapter.kind}`, action: "prepare_application", status: "failed", entityId: app.id, detail: "needs human input" });
      return { outcome: "blocked", result: mk("failed", false, { type: sensitive.length ? "sensitive_eligibility_question" : "missing_profile_field", detail: [...sensitive, ...missing].join("; ") }), filled, applicationId: app.id };
    }

    const verified = deps.verifiedAdapters?.has(adapter.kind) ?? false;
    if (!(liveRequested && verified)) {
      // DRY RUN: form is filled, submit is never clicked.
      if (liveRequested && !verified) await raise("integration_not_connected", `Live mode requested but the ${adapter.kind} adapter is not marked verified; ran as dry-run.`);
      await store.updateApplication(ctx, app.id, { status: "dry_run", lastError: null });
      await store.recordExternalAction(ctx, { system: `ats:${adapter.kind}`, action: "submit_application", status: "dry_run", entityId: app.id, detail: `filled ${filled.join(",")}` });
      await store.logEvent(ctx, "application.dry_run", "application", app.id, { jobId, filled });
      return { outcome: liveRequested ? "live_gated" : "dry_run", result: mk("dry_run"), filled, applicationId: app.id };
    }

    // LIVE (policy.mode==='live' && autoApply && adapter verified)
    if (deps.beforeSubmit && !(await deps.beforeSubmit({ company: job.normalized.company, title: job.normalized.title, url: page.url(), filled }))) {
      await store.updateApplication(ctx, app.id, { status: "dry_run", lastError: "declined_before_submit" });
      await store.logEvent(ctx, "application.declined_before_submit", "application", app.id, { jobId });
      return { outcome: "live_gated", result: mk("dry_run"), filled, applicationId: app.id };
    }
    let clicked = false;
    for (const sel of adapter.submitSelectors) {
      const b = page.locator(sel).first();
      if (await b.count()) { await b.click(); clicked = true; break; }
    }
    if (!clicked) {
      await raise("platform_restricts_automation", "Could not find a submit control.");
      await store.updateApplication(ctx, app.id, { status: "failed", lastError: "no_submit_control" });
      return { outcome: "blocked", result: mk("failed", false, { type: "platform_restricts_automation", detail: "no submit control" }), filled, applicationId: app.id };
    }
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
    const ev = detectConfirmation(adapter, page.url(), await pageText(page));
    if (ev) {
      await store.updateApplication(ctx, app.id, { status: "succeeded", confirmed: true, evidence: ev, submittedAt: new Date().toISOString(), lastError: null });
      await store.setJobStage(ctx, jobId, "applied");
      await store.recordExternalAction(ctx, { system: `ats:${adapter.kind}`, action: "submit_application", status: "succeeded", entityId: app.id, detail: ev.detail });
      await store.logEvent(ctx, "application.submitted", "application", app.id, { jobId, evidence: ev });
      return { outcome: "submitted_confirmed", result: mk("succeeded", true, null, ev), filled, applicationId: app.id };
    }
    await store.updateApplication(ctx, app.id, { status: "unverified", lastError: "no_confirmation_detected" });
    await raise("submission_unverified", "Clicked submit but no confirmation was detected. NOT marked applied; verify via email/portal.");
    await store.recordExternalAction(ctx, { system: `ats:${adapter.kind}`, action: "submit_application", status: "unverified", entityId: app.id });
    return { outcome: "submitted_unverified", result: mk("unverified", false, { type: "submission_unverified", detail: "no confirmation detected" }), filled, applicationId: app.id };
  } finally {
    if (!deps.keepOpen) await opened.close();
  }
}
