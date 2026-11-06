import type { Page } from "playwright";
import { ApplicationAttemptResult, AutomationPolicy, type AtsKind, type Ctx, type ExceptionType, type Store } from "@ros/core";
import type { CandidateProfile } from "../resume/evidence.js";
import { ADAPTERS, detectConfirmation, type AtsAdapter } from "./adapters.js";
import { detectBlockers, pageText, scanForm } from "./browser.js";
import { splitName, type FieldKey } from "./fields.js";

export * from "./adapters.js";
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
}

export type ApplyOutcome = "already_applied" | "dry_run" | "submitted_confirmed" | "submitted_unverified" | "blocked" | "unsupported" | "live_gated";
export interface ApplyReport { outcome: ApplyOutcome; result: ApplicationAttemptResult; filled: string[]; applicationId?: string }

export async function defaultOpenPage(url: string): Promise<OpenedPage> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext()).newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  return { page, close: () => browser.close() };
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
    const blockers = await detectBlockers(page);
    if (blockers.captcha || blockers.authWall) {
      const type: ExceptionType = blockers.captcha ? "captcha" : "auth_required";
      await raise(type, `${blockers.details.join("; ")} at ${page.url()}. Complete this application manually.`);
      await store.updateApplication(ctx, app.id, { status: "failed", lastError: type });
      await store.setJobStage(ctx, jobId, "needs_human");
      await store.recordExternalAction(ctx, { system: `ats:${adapter.kind}`, action: "prepare_application", status: "failed", entityId: app.id, detail: type });
      return { outcome: "blocked", result: mk("failed", false, { type, detail: blockers.details.join("; ") }), filled: [], applicationId: app.id };
    }

    const fields = await scanForm(page);
    const filled: string[] = [], sensitive: string[] = [], missing: string[] = [];
    for (const f of fields) {
      if (f.cls.kind === "sensitive") { if (f.required) sensitive.push(`${f.cls.topic}: "${f.label}"`); continue; }
      if (f.cls.kind === "unknown") { if (f.required) missing.push(f.label || f.name); continue; }
      const loc = page.locator(f.selector);
      if (f.cls.key === "resume") { await loc.setInputFiles(deps.resumePdfPath); filled.push("resume"); continue; }
      if (f.cls.key === "cover_letter_file") continue;
      const v = valueFor(f.cls.key, deps.profile, deps.coverLetter);
      if (v == null || v === "") { if (f.required) missing.push(`${f.cls.key} (no value in profile)`); continue; }
      await loc.fill(v); filled.push(f.cls.key);
    }
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
    await opened.close();
  }
}
