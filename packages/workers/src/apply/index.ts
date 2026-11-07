import type { Page } from "playwright";
import {
  ApplicationAttemptResult, AutomationPolicy, DEFAULT_LIMITS,
  type ApplyAttempt, type AtsKind, type Ctx, type ExceptionType, type ExecutionStrategy, type FormTemplateStore, type PipelineLimits, type Store,
} from "@ros/core";
import type { CandidateProfile } from "../resume/evidence.js";
import { ADAPTERS, detectConfirmation, type AtsAdapter } from "./adapters.js";
import { classifyRaw, detectBlockers, pageText, scanForm, scanRaw, type ClassifyStats, type ScannedField } from "./browser.js";
import { splitName, type FieldKey } from "./fields.js";
import { wantedAnswer, type Wanted } from "./answers.js";
import { CLASSIFIER_VERSION, formSignature, templateFromScan, templateLookup } from "./templates.js";
import { isForbiddenEmail } from "./identity.js";
import { AiBudget, interpretQuestion, stagehandActCostUsd, unsupportedAgent, type AgentRecovery, type LlmFn, type SavedRule, type StagehandProvider } from "./strategies.js";

export * from "./adapters.js";
export * from "./essays.js";
export * from "./fields.js";
export * from "./templates.js";
export * from "./identity.js";
export * from "./strategies.js";
export { scanForm, scanRaw, classifyRaw, detectBlockers } from "./browser.js";

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
  /** Called right after a live submit click and the confirmation check (e.g. to capture evidence). Never called for dry runs. */
  afterSubmit?: (page: Page, info: { confirmed: boolean }) => Promise<void>;
  /** Last gate before a live submit click. Return false to leave the form filled but unsubmitted. */
  beforeSubmit?: (info: { company: string; title: string; url: string; filled: string[] }) => Promise<boolean>;
  /** Shared ATS form memory (selectors/labels/classification only). */
  templates?: FormTemplateStore;
  /** Spending/attempt/runtime limits (defaults to DEFAULT_LIMITS). */
  limits?: PipelineLimits;
  /** Caps the per-application AI budget when the daily/monthly allowance is nearly used up. */
  remainingAiUsd?: number;
  /** Model call used ONLY to map an unfamiliar question to a saved answer (injectable; defaults to llm.ts complete). */
  llm?: LlmFn;
  /** Secondary strategy for fields the deterministic flow cannot operate. Disabled unless provided. */
  stagehand?: StagehandProvider;
  /** Tertiary strategy. Defaults to unsupported. */
  agent?: AgentRecovery;
}

export type ApplyOutcome = "already_applied" | "dry_run" | "submitted_confirmed" | "submitted_unverified" | "blocked" | "unsupported" | "live_gated";
export interface ApplyMetrics extends ApplyAttempt { classifyCalls: number; templateHit: boolean; templateSignature: string | null; pages: number; fallbackAttempts: number }
export interface ApplyReport { outcome: ApplyOutcome; result: ApplicationAttemptResult; filled: string[]; applicationId?: string; attempt?: ApplyMetrics }

const MAX_PAGES = 6;
const NEXT_SELECTORS = ["button:has-text('Next')", "button:has-text('Continue')", "[aria-label='Next']", "a:has-text('Next')"];

/** Company career pages often embed the ATS form in an iframe. Scanning only sees the top document, so open the embedded form directly. */
async function hopToEmbeddedForm(page: Page): Promise<void> {
  // Match the iframe's actual HOST: other frames (e.g. Google API helpers) can carry "greenhouse.io" in their URL parameters.
  const findSrc = () => page.evaluate(() => {
    const re = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com)$/i;
    for (const i of Array.from(document.querySelectorAll("iframe"))) {
      try { if (re.test(new URL(i.src).hostname)) return i.src; } catch { /* ignore frames without a valid src */ }
    }
    return null;
  });
  let src = await findSrc();
  if (!src) {
    // Only wait for a late-loading embed when the page has almost no real form inputs; otherwise there is nothing to wait for.
    const inputs = await page.evaluate(() => document.querySelectorAll("input:not([type=hidden]):not([type=search]), textarea, select").length);
    const hasPassword = await page.evaluate(() => !!document.querySelector("input[type=password]"));
    if (inputs >= 3 || hasPassword) return; // a sign-in wall has nothing to wait for
    await page.waitForSelector("iframe[src*='boards.greenhouse.io'], iframe[src*='job-boards.greenhouse.io'], iframe[src*='jobs.lever.co'], iframe[src*='jobs.ashbyhq.com']", { timeout: 15000 }).catch(() => undefined);
    src = await findSrc();
  }
  if (!src) {
    // Fallback for Greenhouse career pages whose embed has not rendered: build the hosted form address from the page's own embed settings.
    const jid = new URL(page.url()).searchParams.get("gh_jid");
    const board = await page.evaluate(() => {
      for (const s of Array.from(document.querySelectorAll("script[src]"))) {
        const u = (s as HTMLScriptElement).src;
        if (/greenhouse\.io\/embed\/job_board\/js/.test(u)) { try { return new URL(u).searchParams.get("for"); } catch { /* ignore */ } }
      }
      return null;
    });
    if (jid && board && /^[a-z0-9_-]+$/i.test(board)) src = `https://job-boards.greenhouse.io/embed/job_app?for=${board}&token=${jid}`;
  }
  if (!src) return;
  await page.goto(src, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const failedOptions = new Map<string, string[]>();
const optNote = (selector: string) => { const o = failedOptions.get(selector); return o && o.length ? ` [options: ${o.join(" | ")}]` : ""; };

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

/** Attach a file to a file input; verifies the browser actually holds the file, and falls back to the page's Attach/Upload button. */
async function attachFile(page: Page, f: ScannedField, path: string): Promise<boolean> {
  const loc = page.locator(f.selector);
  const held = () => loc.evaluate((el) => ((el as HTMLInputElement).files?.length ?? 0)).catch(() => 0);
  try { await loc.setInputFiles(path, { timeout: 10000 }); if ((await held()) > 0) return true; } catch { /* try the chooser path */ }
  try {
    const wrapper = loc.locator("xpath=ancestor::*[.//button or .//label][1]");
    const btn = wrapper.locator("button, label", { hasText: /attach|upload|choose|browse/i }).first();
    const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 5000 }), btn.click({ timeout: 5000 })]);
    await chooser.setFiles(path);
    return (await held()) > 0;
  } catch { return false; }
}

/** Fill a yes/no style question from a saved answer. Returns false when no control could be matched. */
async function answerField(page: Page, f: ScannedField, want: Wanted, all: ScannedField[]): Promise<boolean> {
  const loc = page.locator(f.selector);
  if (f.tag === "select") {
    const label = f.options.find((o) => want.pick.test(o));
    if (!label) { failedOptions.set(f.selector, f.options.slice(0, 12)); return false; }
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
      const opts = page.locator(`${OPT} >> visible=true`); // only the open menu: hidden lists (e.g. phone country codes) are ignored
      const n = await opts.count();
      for (let i = 0; i < n; i++) {
        const t = (await opts.nth(i).innerText()).trim();
        if (want.pick.test(t)) { await opts.nth(i).click(); return true; }
      }
      return false;
    };
    try {
      await loc.click({ timeout: 5000 });
      await page.waitForTimeout(300);
      if (await choose()) return true;
      await loc.fill(want.text); // typeahead lists (e.g. School) only show matches after typing
      await page.waitForTimeout(500);
      if (await choose()) return true;
      if ((await page.locator(`${OPT} >> visible=true`).count()) === 0) {
        // Options not detectable: Enter picks the first filtered match. Confirm the control now shows the chosen text.
        await page.keyboard.press("Enter");
        await page.waitForTimeout(300);
        const shown = await loc.evaluate((el) => (el.closest("[class*='container'], [class*='select']") as HTMLElement | null)?.innerText ?? "");
        if (shown.toLowerCase().includes(want.text.toLowerCase().slice(0, 6)) && !/no options/i.test(shown)) return true;
      }
    } catch { /* could not operate this dropdown */ }
    // Record what the dropdown offered so the exception can say exactly what the question's choices are.
    try { failedOptions.set(f.selector, (await page.locator(`${OPT} >> visible=true`).allInnerTexts()).map((s) => s.trim()).slice(0, 12)); } catch { /* ignore */ }
    await page.keyboard.press("Escape").catch(() => undefined);
    return false;
  }
  if (!(await loc.isEditable().catch(() => false))) return false; // read-only / script-driven widget: leave to a fallback strategy
  await loc.fill(want.text, { timeout: 8000 }); return true;
}

/** True when the control now shows `text` (or any value when text is empty). */
async function showsValue(page: Page, f: ScannedField, text: string): Promise<boolean> {
  const needle = text.toLowerCase().slice(0, 6);
  return page.locator(f.selector).evaluate((el, n) => {
    const e = el as HTMLInputElement;
    if (e.tagName === "SELECT") { const s = e as unknown as HTMLSelectElement; return (s.selectedOptions[0]?.text ?? "").toLowerCase().includes(n) && (n !== "" || s.selectedIndex > 0); }
    if (e.value && e.value.toLowerCase().includes(n)) return true;
    const box = el.closest("[class*='container'], [class*='select']") as HTMLElement | null;
    return !!box && n !== "" && box.innerText.toLowerCase().includes(n) && !/no options/i.test(box.innerText);
  }, needle).catch(() => false);
}

/** Labels of visible fields the page itself flags as invalid (native :invalid, aria-invalid, or an error class). */
async function invalidFields(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll("input, select, textarea"))) {
      const bad = (el as HTMLInputElement).matches(":invalid") || el.getAttribute("aria-invalid") === "true" || el.classList.contains("error");
      if (!bad || (el as HTMLElement).getClientRects().length === 0) continue;
      const id = (el as HTMLElement).id;
      const lab = (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent) || el.closest("label")?.textContent || el.getAttribute("aria-label") || el.getAttribute("name") || "";
      out.push(lab.replace(/\s+/g, " ").replace(/\*/g, "").trim());
    }
    return out.filter((s) => s.length > 0);
  }).catch(() => []);
}

const valueFor = (key: FieldKey, p: CandidateProfile, cover?: string): string | null => {
  const n = splitName(p.name);
  switch (key) {
    case "first_name": return n.first; case "last_name": return n.last; case "full_name": return p.name;
    case "email": return isForbiddenEmail(p.email) ? null : p.email; case "phone": return p.phone ?? null; case "linkedin": return p.linkedin ?? null;
    case "website": return p.website ?? null; case "location": return p.location ?? null;
    case "cover_letter_text": return cover ?? null; default: return null;
  }
};

// ------------------------------------------------------------------ one page of fields
interface Miss { msg: string; f?: ScannedField; rule?: SavedRule }
interface FillEnv { page: Page; deps: ApplyDeps; job: { company: string; title: string; description: string }; aiRestricted: boolean }
interface PageFill { filled: string[]; sensitive: string[]; misses: Miss[] }

async function fillFields(env: FillEnv, fields: ScannedField[]): Promise<PageFill> {
  const { page, deps, job, aiRestricted } = env;
  const filled: string[] = [], sensitive: string[] = [], misses: Miss[] = [];
  const answered = new Set<string>();
  const deferred: Array<{ f: ScannedField; rule: SavedRule }> = [];
  const boxes: ScannedField[] = [];
  const answeredBoxGroups = new Set<string>();
  for (const f of fields) {
    if (f.cls.kind === "sensitive") {
      const key = `${f.type === "radio" ? "g:" + f.name : f.selector}`;
      if (answered.has(key)) continue;
      const want = wantedAnswer(f.cls.topic, f.group || f.label, deps.profile.eligibility);
      if (want && (await answerField(page, f, want, fields).catch(() => false))) { answered.add(key); filled.push(`answered: ${f.cls.topic}`); continue; }
      if (f.required) sensitive.push(`${f.cls.topic}: "${f.group || f.label}"${optNote(f.selector)}`);
      continue;
    }
    if (f.cls.kind === "ack") {
      try {
        if (f.type === "checkbox") await page.locator(f.selector).check({ force: true, timeout: 5000 });
        else if (!(await answerField(page, f, { text: "Yes", pick: /^\s*(yes|i (acknowledge|confirm|agree|understand))\b/i }, fields))) throw new Error("no matching option");
        filled.push(`acknowledged: ${(f.group || f.label).slice(0, 40)}`);
      } catch { if (f.required) misses.push({ msg: f.group || f.label }); }
      continue;
    }
    if (f.cls.kind === "essay") {
      // A saved short answer (e.g. "N/A") beats generating text.
      const saved = (deps.profile.answers ?? []).find((r) => !r.file && !r.pick && new RegExp(r.match, "i").test(f.label));
      if (saved) { try { await page.locator(f.selector).fill(saved.text, { timeout: 8000 }); filled.push(`answered: ${f.label.slice(0, 40)}`); } catch { if (f.required) misses.push({ msg: f.label }); } continue; }
      if (!deps.draftEssay) { if (f.required) misses.push({ msg: f.label }); continue; }
      try {
        const r = await deps.draftEssay({ question: f.label, company: job.company, title: job.title, description: job.description, aiRestricted });
        if (r?.approved && r.text) { await page.locator(f.selector).fill(r.text, { timeout: 8000 }); filled.push(`essay: ${f.label.slice(0, 40)}`); }
        else if (f.required) misses.push({ msg: `${f.label} (draft saved for your review${aiRestricted ? "; this application restricts AI-written answers, so write your own" : ""})` });
      } catch { if (f.required) misses.push({ msg: f.label }); }
      continue;
    }
    if (f.cls.kind === "unknown" && f.type === "file") {
      // Unlabeled file inputs (e.g. transcripts): attach a saved file when a rule matches the surrounding text.
      const fr = (deps.profile.answers ?? []).find((r) => r.file && new RegExp(r.match, "i").test(f.ctx || f.label));
      if (fr?.file) {
        if (await attachFile(page, f, fr.file)) filled.push(`attached: ${fr.text}`);
        else if (f.required) misses.push({ msg: fr.text });
      }
      continue;
    }
    if (f.cls.kind === "unknown") {
      const q = f.group || f.label;
      const rule = (deps.profile.answers ?? []).find((r) => new RegExp(r.match, "i").test(q) || (f.type === "checkbox" && new RegExp(r.match, "i").test(f.label)));
      if (rule) { deferred.push({ f, rule }); continue; } // saved-answer rules run after the core answers so dropdowns don't interfere
      if (f.type === "checkbox") { boxes.push(f); continue; } // required-ness is per group: decided after the saved answers ran
      if (f.required) misses.push({ msg: f.label || f.name, f });
      continue;
    }
    try {
      if (f.cls.key === "resume") {
        if (await attachFile(page, f, deps.resumePdfPath)) filled.push("resume"); else if (f.required) misses.push({ msg: `resume (could not attach "${f.label}")` });
        continue;
      }
      if (f.cls.key === "cover_letter_file") continue;
      const v = valueFor(f.cls.key, deps.profile, deps.coverLetter);
      if (v == null || v === "") { if (f.required) misses.push({ msg: `${f.cls.key} (no value in profile)` }); continue; }
      await page.locator(f.selector).fill(v, { timeout: 8000 }); filled.push(f.cls.key);
    } catch {
      if (f.required) misses.push({ msg: `${f.cls.key} (could not fill "${f.label}")` });
    }
  }
  for (const { f, rule } of deferred) {
    const q = f.group || f.label;
    const key = f.type === "radio" || f.type === "checkbox" ? `g:${q}` : f.selector;
    const want: Wanted = { text: rule.text, pick: new RegExp(rule.pick ?? escapeRe(rule.text), "i") };
    const ok = await answerField(page, f, want, fields).catch(() => false);
    if (ok) { answered.add(key); if (f.type === "checkbox") answeredBoxGroups.add(f.name); filled.push(`answered: ${q.slice(0, 40)}`); continue; }
    if (f.type === "checkbox") { boxes.push(f); continue; }
    if (f.required) misses.push({ msg: `${f.label || f.name}${optNote(f.selector)}`, f, rule });
  }
  for (const f of boxes) {
    if (answeredBoxGroups.has(f.name)) continue; // another box in this group was chosen by a saved answer; leave the rest unchecked
    if (f.required) misses.push({ msg: f.group || f.label });
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
  return { filled, sensitive, misses };
}

/**
 * SECONDARY/TERTIARY strategies for required, non-sensitive fields the deterministic pass could not answer.
 * A small model may map the QUESTION to one of the applicant's saved answers (never to a guess); Stagehand only operates the control.
 */
async function runFallbacks(
  env: FillEnv, misses: Miss[], all: ScannedField[],
  st: { budget: AiBudget; deadline: number; strategy: ExecutionStrategy; filled: string[] },
): Promise<Miss[]> {
  const { page, deps } = env;
  const remaining: Miss[] = [];
  const rules = deps.profile.answers ?? [];
  for (const m of misses) {
    const f = m.f;
    if (!f || f.cls.kind !== "unknown" || f.type === "file" || f.type === "checkbox" || f.type === "radio" || Date.now() > st.deadline || !st.budget.canAttempt(0)) { remaining.push(m); continue; }
    let rule: SavedRule | null = m.rule ?? null;
    if (!rule) {
      const it = await interpretQuestion({ question: f.group || f.label, options: f.options }, rules, { budget: st.budget, llm: deps.llm });
      if (it.action === "use_saved") rule = rules[it.ruleIndex] ?? null;
    }
    if (!rule) { remaining.push(m); continue; }
    const want: Wanted = { text: rule.text, pick: new RegExp(rule.pick ?? escapeRe(rule.text), "i") };
    let ok = m.rule ? false : await answerField(page, f, want, all).catch(() => false); // a rule that already failed is not retried deterministically
    if (!ok && deps.stagehand && st.budget.canAttempt(stagehandActCostUsd())) {
      const sh = await deps.stagehand(page);
      if (sh.ok) {
        st.budget.attempt(stagehandActCostUsd());
        try {
          await sh.sh.act(`In the form field "${f.group || f.label}", ${f.tag === "select" || f.combo ? "choose" : "enter"} "${rule.text}". Do not click any Submit button.`);
          ok = await showsValue(page, f, rule.text);
          if (ok) st.strategy = "stagehand";
        } catch { /* leave as a miss */ } finally { await sh.sh.close?.().catch(() => undefined); }
      }
    }
    if (!ok && !deps.stagehand && deps.agent && deps.agent !== unsupportedAgent) {
      const r = await deps.agent.recover(page, { reason: "deterministic answer failed", question: f.group || f.label }).catch(() => ({ ok: false, reason: "agent error" }));
      if (r.ok && (await showsValue(page, f, ""))) { ok = true; st.strategy = "agent"; }
    }
    if (ok) st.filled.push(`answered: ${(f.group || f.label).slice(0, 40)}`); else remaining.push(m);
  }
  return remaining;
}

const toAttemptOutcome = (o: ApplyOutcome): ApplyAttempt["outcome"] =>
  o === "submitted_confirmed" || o === "already_applied" ? "submitted_confirmed" : o === "live_gated" ? "dry_run" : o;

/**
 * Prepare (and, only when fully authorized + verified, submit) one application.
 * Guarantees: idempotent per (tenant, job); never submits in dry_run; never bypasses CAPTCHA/auth;
 * never answers sensitive eligibility questions; marks Submitted only with confirmation evidence.
 */
export async function applyToJob(store: Store, ctx: Ctx, jobId: string, deps: ApplyDeps): Promise<ApplyReport> {
  const t0 = Date.now();
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const budget = new AiBudget(limits, deps.remainingAiUsd);
  const stats: ClassifyStats = { classifyCalls: 0, templateHits: 0 };
  const st = { budget, deadline: t0 + limits.maxBrowserSeconds * 1000, strategy: "deterministic" as ExecutionStrategy, filled: [] as string[] };
  let signature: string | null = null, templateHit = false, pageNo = 0, expected = 0;

  const job = await store.getJob(ctx, jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  const policy = AutomationPolicy.parse((await store.getPreferences(ctx)).policy);
  const { app } = await store.getOrCreateApplication(ctx, jobId);
  const mk = (status: ApplicationAttemptResult["status"], confirmed = false, exception: ApplicationAttemptResult["exception"] = null, ev: ApplicationAttemptResult["confirmationEvidence"] = null) =>
    ApplicationAttemptResult.parse({ status, confirmed, exception, confirmationEvidence: ev });
  const raise = async (type: ExceptionType, detail: string) => { await store.raiseException(ctx, { ctx, type, entityType: "application", entityId: app.id, detail }); };
  const finish = (outcome: ApplyOutcome, result: ApplicationAttemptResult, filledArr: string[]): ApplyReport => ({
    outcome, result, filled: filledArr, applicationId: app.id,
    attempt: {
      strategy: st.strategy, outcome: toAttemptOutcome(outcome), seconds: (Date.now() - t0) / 1000, modelCalls: budget.calls, costUsd: budget.spentUsd,
      fieldsFilled: filledArr.length, fieldsExpected: expected || filledArr.length, exception: result.exception ?? undefined,
      classifyCalls: stats.classifyCalls, templateHit, templateSignature: signature, pages: pageNo, fallbackAttempts: budget.fallbackAttempts,
    },
  });

  if (app.confirmed) {
    await store.logEvent(ctx, "application.duplicate_skipped", "application", app.id, { jobId });
    return finish("already_applied", mk("succeeded", true, null, app.evidence as any), []);
  }
  if (isForbiddenEmail(deps.profile.email)) {
    // Business address: refuse before any browser is opened (valueFor also never returns it, as a second line of defense).
    const detail = "The applicant email is a business address (@asvagroup.org), which must never be used on applications. Set application_profile.email to the Tepper address.";
    await raise("missing_profile_field", detail);
    return finish("blocked", mk("failed", false, { type: "missing_profile_field", detail }), []);
  }
  const liveRequested = policy.mode === "live" && policy.autoApply;
  if (liveRequested && app.status === "unverified") {
    // a prior live attempt may have gone through; resubmitting could create a duplicate application
    await raise("submission_unverified", "Previous live submission is unverified; refusing to resubmit. Check the confirmation email/portal and resolve manually.");
    return finish("blocked", mk("unverified", false, { type: "submission_unverified", detail: "prior attempt unverified" }), []);
  }

  const adapter: AtsAdapter | undefined = ADAPTERS[job.normalized.atsKind];
  const applyUrl = job.normalized.applyUrl;
  if (!adapter || !applyUrl) {
    await raise("other", `No supported application adapter for ATS "${job.normalized.atsKind}" (or no apply URL). Apply manually.`);
    await store.setJobStage(ctx, jobId, "needs_human");
    return finish("unsupported", mk("failed", false, { type: "other", detail: "unsupported ATS" }), []);
  }

  await store.updateApplication(ctx, app.id, { attempts: app.attempts + 1, status: "pending", resumeVersionId: deps.resumeVersionId ?? app.resumeVersionId });
  const opened = await (deps.openPage ?? defaultOpenPage)(adapter.formUrl(applyUrl));
  const { page } = opened;
  const allFields: ScannedField[] = [];
  const learn = async (success: boolean) => {
    if (!deps.templates || !signature) return;
    try {
      if (success) {
        await deps.templates.recordSuccess(templateFromScan(adapter.kind, signature, allFields, {
          confirmationSignals: { urlPatterns: adapter.confirmation.urlPatterns.map((r) => r.source), textPatterns: adapter.confirmation.textPatterns.map((r) => r.source) },
        }));
      } else await deps.templates.recordFailure(adapter.kind, signature);
    } catch { /* template memory is best-effort and never blocks an application */ }
  };
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
      return finish("blocked", mk("failed", false, { type, detail: blockers.details.join("; ") }), []);
    }

    const filled: string[] = [];
    let sensitive: string[] = [];
    let misses: Miss[] = [];
    let aiRestricted = false;
    let prevSig: string | null = null;
    let advanceFailed = false;
    let tplLookup: Map<string, string> | undefined;

    for (pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
      const raw = await scanRaw(page);
      const sig = formSignature(raw);
      if (pageNo === 1) {
        if (raw.length === 0) {
          await deps.afterSubmit?.(page, { confirmed: false }).catch(() => undefined); // diagnostics: the unfilled public job page (no personal data on it)
          const wall = (await pageText(page).catch(() => "")).toLowerCase();
          if (/access denied|performing security verification|verify you are human|just a moment|attention required|are you a robot/.test(wall)) {
            // The company's careers site is blocking automated visitors. Never evaded: reported so the user can apply by hand (or from their own computer).
            await raise("platform_restricts_automation", `The company's careers page blocks automated visitors (${new URL(page.url()).host}). Apply manually from the job link.`);
            await store.updateApplication(ctx, app.id, { status: "failed", lastError: "bot_protection" });
            await store.setJobStage(ctx, jobId, "needs_human");
            return finish("blocked", mk("failed", false, { type: "platform_restricts_automation", detail: "careers page blocks automated visitors" }), []);
          }
          await raise("other", `No application form was found at ${page.url()}. Apply manually from the job page.`);
          await store.updateApplication(ctx, app.id, { status: "failed", lastError: "no_form_found" });
          await store.setJobStage(ctx, jobId, "needs_human");
          return finish("blocked", mk("failed", false, { type: "other", detail: "no application form found" }), []);
        }
        signature = sig;
        const tpl = deps.templates ? await deps.templates.get(adapter.kind, sig).catch(() => null) : null;
        templateHit = !!tpl && tpl.version === CLASSIFIER_VERSION;
        tplLookup = templateHit ? templateLookup(tpl) : undefined;
      } else if (sig === prevSig) { advanceFailed = true; break; } // the page did not change after Next: something blocked navigation
      prevSig = sig;

      const fields = classifyRaw(raw, tplLookup, stats);
      allFields.push(...fields);
      aiRestricted = aiRestricted || /ai policy|ai partnership|guidelines for candidates|do not use ai|without (the use of )?ai|generative ai/i.test(await pageText(page));
      const env: FillEnv = { page, deps, job: { company: job.normalized.company, title: job.normalized.title, description: job.normalized.description }, aiRestricted };
      const r = await fillFields(env, fields);
      filled.push(...r.filled);
      sensitive = sensitive.concat(r.sensitive);
      st.filled = filled;
      const left = await runFallbacks(env, r.misses, fields, st);
      misses = misses.concat(left);
      if (sensitive.length || misses.length) break;
      if (Date.now() > st.deadline) { misses.push({ msg: `browser runtime limit of ${limits.maxBrowserSeconds}s reached` }); break; }

      // Final page when a submit control is visible; otherwise advance with Next/Continue.
      let submitVisible = false;
      for (const sel of adapter.submitSelectors) if (await page.locator(sel).first().isVisible().catch(() => false)) { submitVisible = true; break; }
      if (submitVisible) break;
      let nextBtn: ReturnType<Page["locator"]> | null = null;
      for (const sel of NEXT_SELECTORS) { const b = page.locator(sel).first(); if (await b.isVisible().catch(() => false)) { nextBtn = b; break; } }
      if (!nextBtn) break;
      await nextBtn.click({ timeout: 5000 }).catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
      await page.waitForTimeout(250);
    }
    pageNo = Math.min(pageNo, MAX_PAGES);
    expected = filled.length + misses.length + sensitive.length;

    if (advanceFailed) {
      const bad = await invalidFields(page);
      misses.push({ msg: `could not advance to the next page${bad.length ? ` (invalid: ${bad.join(", ")})` : ""}` });
    }
    if (filled.length === 0) {
      await raise("other", `Found a page at ${page.url()} but could not fill any application field. Apply manually from the job page.`);
      await store.updateApplication(ctx, app.id, { status: "failed", lastError: "nothing_filled" });
      await store.setJobStage(ctx, jobId, "needs_human");
      await learn(false);
      return finish("blocked", mk("failed", false, { type: "other", detail: "no application fields could be filled" }), []);
    }
    await deps.afterFill?.(page, { filled }).catch(() => undefined);
    const missing = misses.map((m) => m.msg);
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
      return finish("blocked", mk("failed", false, { type: sensitive.length ? "sensitive_eligibility_question" : "missing_profile_field", detail: [...sensitive, ...missing].join("; ") }), filled);
    }

    const verified = deps.verifiedAdapters?.has(adapter.kind) ?? false;
    if (!(liveRequested && verified)) {
      // DRY RUN: form is filled, submit is never clicked.
      if (liveRequested && !verified) await raise("integration_not_connected", `Live mode requested but the ${adapter.kind} adapter is not marked verified; ran as dry-run.`);
      await store.updateApplication(ctx, app.id, { status: "dry_run", lastError: null });
      await store.recordExternalAction(ctx, { system: `ats:${adapter.kind}`, action: "submit_application", status: "dry_run", entityId: app.id, detail: `filled ${filled.join(",")}` });
      await store.logEvent(ctx, "application.dry_run", "application", app.id, { jobId, filled });
      await learn(true);
      return finish(liveRequested ? "live_gated" : "dry_run", mk("dry_run"), filled);
    }

    // LIVE (policy.mode==='live' && autoApply && adapter verified)
    if (deps.beforeSubmit && !(await deps.beforeSubmit({ company: job.normalized.company, title: job.normalized.title, url: page.url(), filled }))) {
      await store.updateApplication(ctx, app.id, { status: "dry_run", lastError: "declined_before_submit" });
      await store.logEvent(ctx, "application.declined_before_submit", "application", app.id, { jobId });
      return finish("live_gated", mk("dry_run"), filled);
    }
    let clicked = false;
    for (const sel of adapter.submitSelectors) {
      const b = page.locator(sel).first();
      if (await b.isVisible().catch(() => false)) { await b.click(); clicked = true; break; }
    }
    if (!clicked) {
      await raise("platform_restricts_automation", "Could not find a submit control.");
      await store.updateApplication(ctx, app.id, { status: "failed", lastError: "no_submit_control" });
      await learn(false);
      return finish("blocked", mk("failed", false, { type: "platform_restricts_automation", detail: "no submit control" }), filled);
    }
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
    await page.waitForTimeout(250);
    const ev = detectConfirmation(adapter, page.url(), await pageText(page));
    await deps.afterSubmit?.(page, { confirmed: !!ev }).catch(() => undefined);
    if (ev) {
      await store.updateApplication(ctx, app.id, { status: "succeeded", confirmed: true, evidence: ev, submittedAt: new Date().toISOString(), lastError: null });
      await store.setJobStage(ctx, jobId, "applied");
      await store.recordExternalAction(ctx, { system: `ats:${adapter.kind}`, action: "submit_application", status: "succeeded", entityId: app.id, detail: ev.detail });
      await store.logEvent(ctx, "application.submitted", "application", app.id, { jobId, evidence: ev });
      await learn(true);
      return finish("submitted_confirmed", mk("succeeded", true, null, ev), filled);
    }
    // No confirmation. If the page itself rejected the form (validation), nothing was submitted: fail specifically and allow a retry.
    const invalid = await invalidFields(page);
    if (invalid.length) {
      const detail = `Submit was rejected by the form's validation. Invalid field(s): ${invalid.join("; ")}`;
      await store.updateApplication(ctx, app.id, { status: "failed", lastError: "validation_failed" });
      await store.setJobStage(ctx, jobId, "needs_human");
      await raise("missing_profile_field", detail);
      await store.recordExternalAction(ctx, { system: `ats:${adapter.kind}`, action: "submit_application", status: "failed", entityId: app.id, detail: "validation_failed" });
      await learn(false);
      return finish("blocked", mk("failed", false, { type: "missing_profile_field", detail }), filled);
    }
    await store.updateApplication(ctx, app.id, { status: "unverified", lastError: "no_confirmation_detected" });
    const after = (await pageText(page).catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 220);
    await raise("submission_unverified", `Clicked submit but no confirmation was detected at ${page.url()}. NOT marked applied; verify via email/portal. Page said: "${after}"`);
    await store.recordExternalAction(ctx, { system: `ats:${adapter.kind}`, action: "submit_application", status: "unverified", entityId: app.id });
    await learn(false);
    return finish("submitted_unverified", mk("unverified", false, { type: "submission_unverified", detail: "no confirmation detected" }), filled);
  } finally {
    if (!deps.keepOpen) await opened.close();
  }
}
