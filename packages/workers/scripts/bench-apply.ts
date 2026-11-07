// Benchmarks the V3 apply executor against the local MOCK forms and prints what was measured.
//   cd packages/workers && ../../node_modules/.bin/tsx scripts/bench-apply.ts
// Notes on honesty: forms are local mocks (no network latency, no real ATS behaviour). Model calls in the fallback scenarios use a FAKE
// deterministic model and a FAKE Stagehand, so their cost is the executor's ESTIMATE from prompt size, not provider-billed money.
// The old Claude-in-Chrome baseline is not in this repo, so nothing here is compared against it.
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { normalizeJob } from "../src/normalize/index.js";
import { InMemoryFormTemplateStore, applyToJob, type ApplyDeps, type ApplyReport, type LlmFn, type StagehandProvider } from "../src/apply/index.js";
import { ctx, makeFakeStore } from "../test/bStore.js";
import { startFormServer } from "../test/fixtures/forms/mock-forms.js";

const profile = {
  name: "Test Person", email: "test@example.com", phone: "5550100123", linkedin: "https://linkedin.com/in/test", education: [] as string[],
  eligibility: { requiresSponsorship: false, authorizedToWorkUS: true, gender: "male" as const },
  answers: [{ match: "commut|in-office|hybrid", text: "Yes" }],
};
const fakeLlm: LlmFn = async () => ({ text: '{"ruleIndex":0,"needsHuman":false}', source: "anthropic" });
const fakeStagehand: StagehandProvider = async (page) => ({ ok: true, sh: { act: async () => { await page.evaluate(() => { const i = document.getElementById("oc") as HTMLInputElement; i.removeAttribute("readonly"); i.value = "Yes"; }); } } });

type Ats = "greenhouse" | "lever" | "ashby";
interface Scenario { name: string; fixture: string; ats?: Ats; live?: boolean; expect: ApplyReport["outcome"]; deps?: Partial<ApplyDeps>; needsFallback?: boolean; sharedTemplates?: boolean }
const S: Scenario[] = [
  { name: "greenhouse dry-run", fixture: "gh_style", expect: "dry_run" },
  { name: "greenhouse live", fixture: "gh_style", live: true, expect: "submitted_confirmed" },
  { name: "lever live", fixture: "lever_style", ats: "lever", live: true, expect: "submitted_confirmed" },
  { name: "ashby live", fixture: "ashby_style", ats: "ashby", live: true, expect: "submitted_confirmed" },
  { name: "multipage live", fixture: "multipage", live: true, expect: "submitted_confirmed" },
  { name: "resume upload dry-run", fixture: "resume_upload", expect: "dry_run" },
  { name: "greenhouse live (template reuse #1)", fixture: "gh_style", live: true, expect: "submitted_confirmed", sharedTemplates: true },
  { name: "greenhouse live (template reuse #2)", fixture: "gh_style", live: true, expect: "submitted_confirmed", sharedTemplates: true },
  { name: "unfamiliar question + model mapping", fixture: "unknown_custom", expect: "dry_run", deps: { llm: fakeLlm }, needsFallback: true },
  { name: "custom widget + Stagehand", fixture: "custom_widget", expect: "dry_run", deps: { llm: fakeLlm, stagehand: fakeStagehand }, needsFallback: true },
  { name: "validation failure (live)", fixture: "validation_fail", live: true, expect: "blocked", deps: { profile: { ...profile, phone: "555" } } },
  { name: "required sensitive, no saved answer", fixture: "disability_required", live: true, expect: "blocked" },
];

async function main() {
  const srv = await startFormServer();
  const browser = await chromium.launch({ headless: true });
  const pdfPath = join(mkdtempSync(join(tmpdir(), "bench-")), "resume.pdf");
  writeFileSync(pdfPath, "%PDF-1.4 bench");
  const shared = new InMemoryFormTemplateStore();
  const rows: Array<{ s: Scenario; r: ApplyReport; wallMs: number }> = [];
  for (const s of S) {
    const f = makeFakeStore();
    await f.store.setPreferences(ctx, { policy: { mode: s.live ? "live" : "dry_run", autoApply: !!s.live } as any });
    const ats = s.ats ?? "greenhouse";
    const url = ats === "greenhouse" ? `https://boards.greenhouse.io/acme/jobs/${Math.floor(Math.random() * 1e9)}` : ats === "lever" ? `https://jobs.lever.co/acme/${randomUUID()}` : `https://jobs.ashbyhq.com/acme/${randomUUID()}`;
    const { job } = await f.store.upsertJob(ctx, `ing-${randomUUID()}`, normalizeJob({ job: { title: "Product Management Intern", company: "Acme", applyUrl: url, description: "Summer 2027 internship" } }));
    const deps: ApplyDeps = {
      profile, resumePdfPath: pdfPath, verifiedAdapters: new Set([ats]),
      openPage: async () => { const p = await (await browser.newContext()).newPage(); await p.goto(`${srv.base}/${s.fixture}`); return { page: p, close: () => p.context().close() }; },
      ...(s.sharedTemplates ? { templates: shared } : {}), ...(s.deps ?? {}),
    };
    const t = Date.now();
    const r = await applyToJob(f.store, ctx, job.id, deps);
    rows.push({ s, r, wallMs: Date.now() - t });
  }
  await browser.close(); await srv.close();

  const pad = (v: string | number, n: number) => String(v).padEnd(n);
  console.log(`\n${pad("scenario", 38)}${pad("outcome", 22)}${pad("as expected", 12)}${pad("sec", 7)}${pad("model", 7)}${pad("est $", 10)}${pad("filled", 9)}${pad("classify", 9)}tpl`);
  for (const { s, r } of rows) {
    const a = r.attempt!;
    console.log(`${pad(s.name, 38)}${pad(r.outcome, 22)}${pad(r.outcome === s.expect ? "yes" : "NO", 12)}${pad(a.seconds.toFixed(2), 7)}${pad(a.modelCalls, 7)}${pad(a.costUsd.toFixed(5), 10)}${pad(`${a.fieldsFilled}/${a.fieldsExpected}`, 9)}${pad(a.classifyCalls, 9)}${a.templateHit ? "hit" : "-"}`);
  }
  const liveRows = rows.filter((x) => x.s.live && x.s.expect === "submitted_confirmed");
  const done = rows.filter((x) => x.r.outcome === "submitted_confirmed" || x.r.outcome === "dry_run");
  const sum = (f: (x: (typeof rows)[number]) => number, xs = rows) => xs.reduce((a, x) => a + f(x), 0);
  const fb = rows.filter((x) => x.s.needsFallback);
  console.log("\nSUMMARY (local mock forms)");
  console.log(`  applications run:               ${rows.length}`);
  console.log(`  behaved as designed:            ${rows.filter((x) => x.r.outcome === x.s.expect).length}/${rows.length}`);
  console.log(`  live submit success (confirmed): ${liveRows.filter((x) => x.r.outcome === "submitted_confirmed").length}/${liveRows.length}`);
  console.log(`  mean time per completed form:   ${(sum((x) => x.r.attempt!.seconds, done) / Math.max(done.length, 1)).toFixed(2)} s`);
  console.log(`  model calls (total):            ${sum((x) => x.r.attempt!.modelCalls)}   est. cost: $${sum((x) => x.r.attempt!.costUsd).toFixed(5)} (estimate; fake model)`);
  console.log(`  field accuracy (filled/expected, completed forms): ${(100 * sum((x) => x.r.attempt!.fieldsFilled, done) / Math.max(sum((x) => x.r.attempt!.fieldsExpected, done), 1)).toFixed(1)}%`);
  console.log(`  fallback recovery:              ${fb.filter((x) => x.r.outcome === x.s.expect).length}/${fb.length} forms needing a fallback were completed`);
  console.log(`  manual interventions raised:    ${rows.filter((x) => x.r.outcome === "blocked").length} (all by design in this suite)`);
  const t1 = rows.find((x) => x.s.name.endsWith("#1)")), t2 = rows.find((x) => x.s.name.endsWith("#2)"));
  if (t1 && t2) console.log(`  template reuse: classify calls ${t1.r.attempt!.classifyCalls} -> ${t2.r.attempt!.classifyCalls}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
