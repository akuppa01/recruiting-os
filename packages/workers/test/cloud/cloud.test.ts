// Cloud worker phases against in-memory stores/queue and the local MOCK forms (never real company pages, never real submits).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import type { Ctx, DiscoveredJob, SourceAdapter } from "@ros/core";
import { InMemoryStore, InMemoryTaskQueue } from "@ros/db";
import { InMemorySourceHealthStore } from "../../src/discovery/health.js";
import { startFormServer, type FormServer } from "../fixtures/forms/mock-forms.js";
import {
  InMemoryDraftCache, InMemoryUsageRecorder, MissingAssetsError, UsageMeter, buildNotification, createApplyHandler, createLogger,
  discoveryPhase, downloadAssets, enqueueApplyPhase, resolveAnswerFiles, runApplyPhase, type ApplicantBundle, type ApplyResultRecord, type StorageLike,
} from "../../src/cloud/index.js";

const ctx: Ctx = { tenantId: "00000000-0000-4000-8000-0000000000c1", userId: "00000000-0000-4000-8000-0000000000c2" };
const ME = { name: "Test Person", email: "test.person@example.com", phone: "555-010-0123" };
const T = 90_000;

let srv: FormServer, browser: Browser, pdf = "";
beforeAll(async () => {
  srv = await startFormServer();
  pdf = join(mkdtempSync(join(tmpdir(), "cloud-")), "resume.pdf");
  writeFileSync(pdf, "%PDF-1.4 test");
  browser = await chromium.launch({ headless: true });
}, T);
afterAll(async () => { await browser?.close(); await srv?.close(); });

let n = 0;
const gh = (title: string, company: string, extra: Partial<DiscoveredJob["job"]> = {}): DiscoveredJob => ({
  source: "greenhouse", sourceRef: `greenhouse:acme:${++n}`, canonicalUrl: `https://boards.greenhouse.io/acme/jobs/${100000 + n}`,
  job: { title, company, location: "San Francisco, CA", description: "Summer 2027 internship. Work with the platform and data teams on go-to-market.", applyUrl: `https://boards.greenhouse.io/acme/jobs/${100000 + n}`, ...extra },
  evidence: { kind: "feed", board: "acme" },
});
const adapter = (jobs: DiscoveredJob[]): SourceAdapter => ({ id: "greenhouse", kind: "feed", run: async () => ({ source: "greenhouse", jobs }) });

const prefsOf = async (store: InMemoryStore, policy: Record<string, unknown> = {}) =>
  store.setPreferences(ctx, { policy: { mode: "live", autoApply: true, minScoreToApply: 60, maxApplicationsPerDay: 5, ...policy } as never });

async function discoverInto(store: InMemoryStore, jobs: DiscoveredJob[], health = new InMemorySourceHealthStore()) {
  const prefs = await store.getPreferences(ctx);
  const logs: string[] = [];
  const r = await discoveryPhase({ store, ctx, prefs, log: (m) => logs.push(m), feedAdapters: [adapter(jobs)], healthStore: health });
  return { r, logs, health };
}

describe("phase A: discovery + ingestion is idempotent", () => {
  it("re-running does not duplicate jobs, qualifies the right one, archives the rest, records source health", async () => {
    const store = new InMemoryStore();
    await prefsOf(store);
    const jobs = [gh("Product Management Intern (Summer 2027)", "Acme"), gh("Senior Software Engineer", "Acme", { description: "Full-time engineering role." })];
    const health = new InMemorySourceHealthStore();

    const a = await discoverInto(store, jobs, health);
    expect(a.r).toMatchObject({ found: 2, created: 2, existing: 0, qualified: 1, archived: 1, failed: 0 });
    const afterFirst = await store.searchJobs(ctx, { limit: 50 });
    expect(afterFirst).toHaveLength(2);
    expect(afterFirst.find((j) => j.normalized.title.startsWith("Product"))!.stage).toBe("qualified");
    expect(afterFirst.find((j) => j.normalized.title.startsWith("Senior"))!.stage).toBe("archived");

    const b = await discoverInto(store, jobs, health);
    expect(b.r).toMatchObject({ found: 2, created: 0, existing: 2 });
    expect(await store.searchJobs(ctx, { limit: 50 })).toHaveLength(2);        // no duplicates
    const h = await health.list(ctx);
    expect(h.find((x) => x.source === "greenhouse")).toMatchObject({ status: "ok", itemsLastRun: 2 });
  });

  it("pushed alert emails are parsed by the email adapters and the same email twice creates the job once", async () => {
    const store = new InMemoryStore();
    await prefsOf(store);
    const email = {
      from: "Handshake <no-reply@joinhandshake.com>", subject: "New jobs for you", messageId: "m-1",
      text: "Product Management Intern, Summer 2027\nAcme · San Francisco, CA\nhttps://joinhandshake.com/jobs/9876543\n",
    };
    const prefs = await store.getPreferences(ctx);
    const run = () => discoveryPhase({ store, ctx, prefs, log: () => undefined, feedAdapters: [], healthStore: new InMemorySourceHealthStore(), pushedEmails: [{ taskId: "t1", email }] });
    const first = await run();
    const second = await run();
    expect(first.emailsProcessed).toBe(1);
    expect(first.found).toBeGreaterThanOrEqual(1);
    expect(second.created).toBe(0);                                              // idempotent on the canonical URL
    expect((await store.searchJobs(ctx, { limit: 50 })).length).toBe(first.created);
  });
});

describe("phase B: enqueue under policy, score, ATS support, daily cap", () => {
  async function seeded(policy: Record<string, unknown>) {
    const store = new InMemoryStore();
    await prefsOf(store, policy);
    await discoverInto(store, [gh("Product Management Intern, Summer 2027", "Acme"), gh("Product Marketing Intern, Summer 2027", "Beta"), gh("GTM Strategy Intern, Summer 2027", "Gamma")]);
    return { store, queue: new InMemoryTaskQueue(), prefs: await store.getPreferences(ctx) };
  }

  it("enforces maxApplicationsPerDay, counts already-queued tasks, and never double-enqueues", async () => {
    const { store, queue, prefs } = await seeded({ maxApplicationsPerDay: 2 });
    const deps = { store, queue, ctx, prefs, log: () => undefined, countAppsToday: async () => 0 };
    const a = await enqueueApplyPhase(deps);
    expect(a).toMatchObject({ mode: "live", candidates: 3, enqueued: 2, capRemaining: 2, cappedOut: 1 });
    const again = await enqueueApplyPhase(deps);                                  // queued tasks already use the whole cap
    expect(again.enqueued).toBe(0);
    expect(await queue.list(ctx, { kind: "apply" })).toHaveLength(2);

    const q2 = new InMemoryTaskQueue();
    const used = await enqueueApplyPhase({ ...deps, queue: q2, countAppsToday: async () => 1 });   // one application already created today
    expect(used.capRemaining).toBe(1); expect(used.enqueued).toBe(1);
  });

  it("dry-run mode (forced, or saved policy not live) enqueues dry_run tasks; auto-apply off enqueues nothing automatic", async () => {
    const forced = await seeded({});
    const f = await enqueueApplyPhase({ ...forced, ctx, log: () => undefined, countAppsToday: async () => 0, forceDryRun: true });
    expect(f.mode).toBe("dry_run");
    expect((await forced.queue.list(ctx, { kind: "apply" })).every((t) => t.idempotencyKey.endsWith(":dry_run") && t.payload.mode === "dry_run")).toBe(true);

    const off = await seeded({ autoApply: false });
    const o = await enqueueApplyPhase({ ...off, ctx, log: () => undefined, countAppsToday: async () => 0 });
    expect(o.candidates).toBe(0);
  });

  it("skips unsupported ATS and jobs already applied/unverified", async () => {
    const store = new InMemoryStore();
    await prefsOf(store);
    await discoverInto(store, [gh("Product Management Intern, Summer 2027", "Acme", { applyUrl: "https://acme.wd1.myworkdayjobs.com/en-US/careers/job/123" })]);
    const q = new InMemoryTaskQueue();
    const r = await enqueueApplyPhase({ store, queue: q, ctx, prefs: await store.getPreferences(ctx), log: () => undefined, countAppsToday: async () => 0 });
    expect(r.candidates).toBe(0);
  });
});

describe("phase C: apply handler on a mock Greenhouse-style form", () => {
  const profile = { name: ME.name, email: ME.email, phone: ME.phone, linkedin: "https://linkedin.com/in/test", education: [] as string[], eligibility: { requiresSponsorship: false, authorizedToWorkUS: true, gender: "male" as const } };
  const makeBundle = (): ApplicantBundle => ({
    profile, aboutPath: "unused",
    resumes: Object.fromEntries(["PM", "GTM", "Strategy", "Founders_Office"].map((b) => [b, { pdf, docx: `${b}.docx` }])) as ApplicantBundle["resumes"],
  });   // built per run: `pdf` only exists after beforeAll

  async function run(policy: Record<string, unknown>, o: { forceDryRun?: boolean; highlights?: string[] } = {}) {
    srv.reset();
    const store = new InMemoryStore();
    await prefsOf(store, policy);
    await discoverInto(store, [gh("Product Management Intern, Summer 2027", "Acme")]);
    const queue = new InMemoryTaskQueue();
    const prefs = await store.getPreferences(ctx);
    await enqueueApplyPhase({ store, queue, ctx, prefs, log: () => undefined, countAppsToday: async () => 0, forceDryRun: o.forceDryRun });
    const usage = new InMemoryUsageRecorder();
    const tracking: Array<{ jobId: string; patch: Record<string, unknown> }> = [];
    const results: ApplyResultRecord[] = [];
    const evidence: number[] = [];
    let opened = 0;
    const logger = createLogger({ personal: [ME.name, ME.email, ME.phone], sink: () => undefined });
    const handler = createApplyHandler({
      store, usage, drafts: new InMemoryDraftCache(), bundleFor: async () => makeBundle(),
      tracking: async (_c, jobId, patch) => { tracking.push({ jobId, patch }); },
      uploadEvidence: async (_c, _j, png) => { evidence.push(png.length); },
      readHighlights: () => o.highlights ?? [], readDocxText: () => "resume text", forceDryRun: o.forceDryRun,
      openPage: async () => { opened++; const p = await (await browser.newContext()).newPage(); await p.goto(`${srv.base}/gh_style`); return { page: p, close: () => p.context().close() }; },
      log: logger.line, onResult: (r) => results.push(r),
    });
    const summary = await runApplyPhase({ queue, handler, workerId: "test-worker", deadline: new Date(Date.now() + 120_000), log: logger.line });
    const apps = await Promise.all((await store.searchJobs(ctx, { limit: 50 })).map((j) => store.getApplicationByJob(ctx, j.id)));
    const why = (await store.listExceptions(ctx)).map((e) => `${e.type}: ${e.detail}`).join(" || ");
    return { store, queue, usage, tracking, results, evidence, opened: () => opened, logger, summary, why, apps: apps.filter((a) => !!a) };
  }

  it("dry run fills the form but never submits; records dry_run, usage rows and tracking notes", async () => {
    const r = await run({ mode: "dry_run", autoApply: true }, { forceDryRun: true });
    expect(r.results.map((x) => x.outcome), r.why).toEqual(["dry_run"]);
    expect(srv.hits()).toBe(0);
    expect(r.apps[0]).toMatchObject({ status: "dry_run", confirmed: false });
    expect(r.tracking[0]!.patch.status).toBeUndefined();                        // no applied state without a real submission
    expect(String(r.tracking[0]!.patch.notes)).toContain("not submitted");
    const metrics = r.usage.rows.map((x) => x.metric);
    expect(metrics).toEqual(expect.arrayContaining(["browser.runs", "applications.attempted", "applications.dry_run"]));
    expect(metrics).not.toContain("applications.confirmed");
  }, T);

  it("live (policy live + verified adapter) submits once, confirms with evidence, stores host-only evidence and a screenshot", async () => {
    const r = await run({ mode: "live", autoApply: true });
    expect(r.results.map((x) => x.outcome), r.why).toEqual(["submitted_confirmed"]);
    expect(srv.hits()).toBe(1);
    expect(r.tracking[0]!.patch.status).toBe("applied");
    expect(r.evidence.length).toBe(1); expect(r.evidence[0]).toBeGreaterThan(0);
    const app = r.apps[0]!;
    expect(app).toMatchObject({ status: "succeeded", confirmed: true });
    const ev = app.evidence as Record<string, unknown>;
    expect(Object.keys(ev).sort()).toEqual(["detail", "host", "kind"]);          // no full URL, no page text
    expect(r.usage.rows.map((x) => x.metric)).toEqual(expect.arrayContaining(["applications.confirmed", "browser.runs"]));
    const rep = await r.queue.list(ctx, { kind: "apply" });
    expect(rep[0]!.status).toBe("done");
    expect(rep[0]!.result).toMatchObject({ outcome: "submitted_confirmed", strategy: "deterministic", modelCalls: 0 });
  }, T);

  it("refuses a live submission when the resume has unconfirmed highlighted text (no browser opened)", async () => {
    const r = await run({ mode: "live", autoApply: true }, { highlights: ["2 clients"] });
    expect(r.results[0]).toMatchObject({ outcome: "blocked", failure: "unconfirmed_resume_text" });
    expect(r.opened()).toBe(0); expect(srv.hits()).toBe(0);
    expect((await r.store.listExceptions(ctx, true)).some((e) => e.type === "low_factual_confidence")).toBe(true);
  }, T);

  it("log lines never contain the applicant's name, email or phone", async () => {
    const r = await run({ mode: "live", autoApply: true });
    expect(r.logger.lines.length).toBeGreaterThan(0);
    for (const line of r.logger.lines) {
      expect(line).not.toContain(ME.email); expect(line).not.toContain(ME.phone); expect(line.toLowerCase()).not.toContain(ME.name.toLowerCase());
    }
  }, T);
});

describe("logger, usage metering, notifications, assets", () => {
  it("the logger redacts personal strings and anything shaped like an email or phone", () => {
    const out: string[] = [];
    const log = createLogger({ personal: ["Test Person"], sink: (s) => out.push(s) });
    log.line("Test Person applied via test.person@example.com or (555) 010-0123 / 555-010-0123");
    expect(out[0]).not.toMatch(/Test Person|@example\.com|010-0123/);
  });

  it("usage meter labels measured vs estimated numbers", () => {
    const m = new UsageMeter();
    m.sink({ model: "claude-haiku-5-5", inputTokens: 1000, outputTokens: 500, measured: true });
    const rows = m.toRows();
    expect(rows.find((r) => r.metric === "llm.calls")).toMatchObject({ quantity: 1, model: "claude-haiku-5-5", ref: "tokens measured; price assumed" });
    expect(rows.find((r) => r.metric === "llm.calls")!.costUsd).toBeGreaterThan(0);
    expect(rows.find((r) => r.metric === "llm.input_tokens")).toMatchObject({ quantity: 1000, ref: "measured" });
    const e = new UsageMeter(); e.sink({ model: "m", inputTokens: 10, outputTokens: 5, measured: false });
    expect(e.toRows()[0]!.ref).toBe("estimate");
    expect(new UsageMeter().toRows()).toEqual([]);                                // no model calls => no AI usage rows
  });

  it("notifications are quiet unless something noteworthy happened, and carry no personal data", () => {
    const base = { dryRun: false, results: [] as ApplyResultRecord[], failedTasks: 0 };
    const r = (outcome: string, failure?: string): ApplyResultRecord => ({ jobId: "j", company: "Acme", title: "PM Intern", ats: "greenhouse", outcome, ...(failure ? { failure } : {}) });
    expect(buildNotification(base)).toBeNull();                                   // nothing happened
    expect(buildNotification({ ...base, results: [r("dry_run"), r("skipped_unverified")] })).toBeNull();
    expect(buildNotification({ ...base, dryRun: true, results: [r("submitted_confirmed")] })).toBeNull();   // manual dry runs stay quiet
    const ok = buildNotification({ ...base, results: [r("submitted_confirmed")] }, "https://app.example/");
    expect(ok).toMatchObject({ kind: "application_confirmed", url: "https://app.example/inbox" });
    expect(ok!.title).toContain("1 application confirmed");
    const bad = buildNotification({ ...base, results: [r("blocked", "auth_required"), r("submitted_unverified")] });
    expect(bad).toMatchObject({ kind: "exception" });
    expect(bad!.title).toMatch(/need a sign-in/);
    expect(JSON.stringify(bad)).not.toMatch(/@|\d{3}[ .-]\d{3}[ .-]\d{4}/);
  });

  const fakeStorage = (files: Record<string, string>): StorageLike => ({
    storage: { from: () => ({
      list: async () => ({ data: Object.keys(files).map((name) => ({ name })), error: null }),
      download: async (p: string) => ({ data: new Blob([files[p.split("/").pop()!] ?? ""]), error: null }),
      upload: async () => ({ error: null }),
    }) },
  });

  it("assets: a missing required file fails clearly; a saved file answer is remapped by basename and neutralized when absent", async () => {
    const all: Record<string, string> = { "about_me.md": "facts", "AK.2025.UTAustinPDFTranscript.pdf": "pdf" };
    for (const b of ["PM", "GTM", "Strategy", "Founders_Office"]) { all[`${b}_Resume.pdf`] = "pdf"; all[`${b}_Resume.docx`] = "docx"; }
    const dir = mkdtempSync(join(tmpdir(), "assets-"));
    const bundle = await downloadAssets(fakeStorage(all), "user-1", dir);
    expect(bundle.resumes.PM.pdf).toContain("PM_Resume.pdf");

    const broken = { ...all }; delete broken["about_me.md"];
    await expect(downloadAssets(fakeStorage(broken), "user-1", dir)).rejects.toBeInstanceOf(MissingAssetsError);

    const rules = [{ match: "transcript of your undergraduate", text: "undergraduate transcript", file: "/Users/someone/Desktop/AK.2025.UTAustinPDFTranscript.pdf" }];
    const ok = resolveAnswerFiles(rules, bundle.files);
    expect(ok.answers[0]!.file).toBe(bundle.files["AK.2025.UTAustinPDFTranscript.pdf"]); expect(ok.droppedFiles).toBe(0);
    const gone = resolveAnswerFiles(rules, {});
    expect(gone.droppedFiles).toBe(1); expect(gone.answers[0]!.file).toBeUndefined();
    expect(new RegExp(gone.answers[0]!.match, "i").test("transcript of your undergraduate studies")).toBe(false);
  });
});
