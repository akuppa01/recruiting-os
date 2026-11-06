import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { normalizeJob } from "../src/normalize/index.js";
import { applyToJob, classifyField, detectConfirmation, greenhouse, lever, ashby, type ApplyDeps } from "../src/apply/index.js";
import { forms } from "./fixtures/forms/forms.js";
import { makeFakeStore, ctx } from "./bStore.js";

let server: Server, base = "", hits = 0, browser: Browser | null = null, pdfPath = "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/hit") { hits++; res.writeHead(204).end(); return; }
    const name = (req.url ?? "").replace(/^\//, "");
    res.writeHead(forms[name] ? 200 : 404, { "content-type": "text/html" }).end(forms[name] ?? "nf");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  pdfPath = join(mkdtempSync(join(tmpdir(), "res-")), "resume.pdf"); writeFileSync(pdfPath, "%PDF-1.4 test");
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => { await browser?.close(); server?.close(); });

const profile = { name: "Test Person", email: "test@example.com", phone: "555-0100", linkedin: "https://linkedin.com/in/test", education: [] as string[] };
let n = 0;
async function setup(fixture: string, policy: Record<string, unknown> = {}, ats = "greenhouse") {
  const f = makeFakeStore();
  await f.store.setPreferences(ctx, { policy: { mode: "dry_run", autoApply: false, ...policy } as any });
  const url = ats === "greenhouse" ? `https://boards.greenhouse.io/acme/jobs/${++n}` : `https://careers.acme.com/job/${++n}`;
  const { job } = await f.store.upsertJob(ctx, "ing", normalizeJob({ job: { title: "Product Management Intern", company: "Acme", applyUrl: url, description: "Summer 2027 MBA internship" } }));
  const deps: ApplyDeps = {
    profile, resumePdfPath: pdfPath, verifiedAdapters: new Set(),
    openPage: async () => { const p = await (await browser!.newContext()).newPage(); await p.goto(`${base}/${fixture}`); return { page: p, close: () => p.context().close() }; },
  };
  return { f, job, deps };
}
const live = { mode: "live", autoApply: true };

describe("pure helpers", () => {
  it("classifyField", () => {
    expect(classifyField("First name *", "first_name")).toEqual({ kind: "known", key: "first_name" });
    expect(classifyField("Email", "email").kind).toBe("known");
    expect(classifyField("Resume/CV", "resume", "file")).toEqual({ kind: "known", key: "resume" });
    expect(classifyField("Will you require visa sponsorship?")).toMatchObject({ kind: "sensitive" });
    expect(classifyField("Veteran Status")).toMatchObject({ kind: "sensitive" });
    expect(classifyField("Favorite color?")).toEqual({ kind: "unknown" });
  });
  it("detectConfirmation needs positive evidence", () => {
    expect(detectConfirmation(greenhouse, "https://x/confirmation", "Thank you for applying!")?.kind).toBe("confirmation_page_text");
    expect(detectConfirmation(lever, "https://x", "Application submitted!")).not.toBeNull();
    expect(detectConfirmation(ashby, "https://x", "Your application was successfully submitted")).not.toBeNull();
    expect(detectConfirmation(greenhouse, "https://x", "Something went wrong. Please try again.")).toBeNull();
    expect(detectConfirmation(greenhouse, "https://x", "")).toBeNull();
  });
});

describe("applyToJob against local fixture forms", () => {
  it("DRY RUN fills but never submits", async () => {
    hits = 0; const { f, job, deps } = await setup("ok");
    const r = await applyToJob(f.store, ctx, job.id, deps);
    expect(r.outcome).toBe("dry_run"); expect(r.result.status).toBe("dry_run"); expect(r.result.confirmed).toBe(false);
    expect(r.filled).toEqual(expect.arrayContaining(["first_name", "last_name", "email", "phone", "linkedin", "resume"]));
    await sleep(100); expect(hits).toBe(0);
    expect((await f.store.getApplicationByJob(ctx, job.id))!.status).toBe("dry_run");
    expect((await f.store.getJob(ctx, job.id))!.stage).not.toBe("applied");
    expect(f.actions[0]).toMatchObject({ status: "dry_run" });
  });

  it("live requested but adapter unverified -> gated to dry-run + exception", async () => {
    hits = 0; const { f, job, deps } = await setup("ok", live);
    const r = await applyToJob(f.store, ctx, job.id, deps);
    expect(r.outcome).toBe("live_gated"); await sleep(100); expect(hits).toBe(0);
    expect(f.exceptions.map((e) => e.type)).toContain("integration_not_connected");
  });

  it("live + verified + confirmation => applied with evidence; second call is idempotent", async () => {
    hits = 0; const { f, job, deps } = await setup("ok", live); deps.verifiedAdapters = new Set(["greenhouse"]);
    const r = await applyToJob(f.store, ctx, job.id, deps);
    expect(r.outcome).toBe("submitted_confirmed"); expect(r.result.confirmed).toBe(true); expect(r.result.confirmationEvidence?.kind).toBe("confirmation_page_text");
    expect(hits).toBe(1);
    expect((await f.store.getJob(ctx, job.id))!.stage).toBe("applied");
    const again = await applyToJob(f.store, ctx, job.id, deps);
    expect(again.outcome).toBe("already_applied"); await sleep(100); expect(hits).toBe(1);
  });

  it("live submit w/o confirmation => unverified, NOT applied, and never resubmitted", async () => {
    hits = 0; const { f, job, deps } = await setup("noconfirm", live); deps.verifiedAdapters = new Set(["greenhouse"]);
    const r = await applyToJob(f.store, ctx, job.id, deps);
    expect(r.outcome).toBe("submitted_unverified"); expect(r.result.confirmed).toBe(false);
    expect((await f.store.getJob(ctx, job.id))!.stage).not.toBe("applied");
    expect(f.exceptions.map((e) => e.type)).toContain("submission_unverified");
    const again = await applyToJob(f.store, ctx, job.id, deps);
    expect(again.outcome).toBe("blocked"); await sleep(100); expect(hits).toBe(1);
  });

  it("CAPTCHA => exception, nothing filled or submitted, no bypass", async () => {
    hits = 0; const { f, job, deps } = await setup("captcha", live); deps.verifiedAdapters = new Set(["greenhouse"]);
    const r = await applyToJob(f.store, ctx, job.id, deps);
    expect(r.outcome).toBe("blocked"); expect(r.filled).toEqual([]); await sleep(100); expect(hits).toBe(0);
    expect(f.exceptions[0]!.type).toBe("captcha");
    expect((await f.store.getJob(ctx, job.id))!.stage).toBe("needs_human");
  });

  it("auth wall => auth_required exception", async () => {
    const { f, job, deps } = await setup("auth");
    expect((await applyToJob(f.store, ctx, job.id, deps)).outcome).toBe("blocked");
    expect(f.exceptions[0]!.type).toBe("auth_required");
  });

  it("required sensitive eligibility question => exception; never auto-answered", async () => {
    hits = 0; const { f, job, deps } = await setup("sensitive_required", live); deps.verifiedAdapters = new Set(["greenhouse"]);
    const r = await applyToJob(f.store, ctx, job.id, deps);
    expect(r.outcome).toBe("blocked"); await sleep(100); expect(hits).toBe(0);
    expect(f.exceptions.map((e) => e.type)).toContain("sensitive_eligibility_question");
    expect(f.exceptions[0]!.detail).toMatch(/sponsorship/i);
  });

  it("optional EEO questions are left blank, application still proceeds", async () => {
    const { f, job, deps } = await setup("sensitive_optional");
    const r = await applyToJob(f.store, ctx, job.id, deps);
    expect(r.outcome).toBe("dry_run"); expect(f.exceptions).toHaveLength(0);
  });

  it("unknown required field => missing_profile_field exception", async () => {
    const { f, job, deps } = await setup("unknown_required");
    const r = await applyToJob(f.store, ctx, job.id, deps);
    expect(r.outcome).toBe("blocked"); expect(f.exceptions[0]!.type).toBe("missing_profile_field"); expect(f.exceptions[0]!.detail).toMatch(/favorite color/i);
  });

  it("unsupported ATS => exception, no browser opened", async () => {
    const { f, job, deps } = await setup("ok", {}, "other");
    let opened = false; deps.openPage = async () => { opened = true; throw new Error("should not open"); };
    const r = await applyToJob(f.store, ctx, job.id, deps);
    expect(r.outcome).toBe("unsupported"); expect(opened).toBe(false);
  });
});
