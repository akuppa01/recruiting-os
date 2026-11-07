// Mac auto-apply worker. Processes jobs you moved to the "Auto-apply queue" using the Playwright adapters in @ros/workers.
//
//   cd apps/web && ../../node_modules/.bin/tsx scripts/auto-apply-worker.ts [--limit 5] [--headed]            dry run: fills the form, never submits
//   cd apps/web && ../../node_modules/.bin/tsx scripts/auto-apply-worker.ts --submit --verify greenhouse --headed   live, you confirm each submit
//
// Live submission needs ALL of: --submit, your saved policy set to live + auto-apply (Settings), the ATS named in --verify,
// no unconfirmed (highlighted) text in the resume used, and your "y" at the terminal for each application.
// Applied is recorded only when the confirmation page text is seen. CAPTCHAs, sign-in walls and eligibility questions are never bypassed.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { AutomationPolicy, type AtsKind } from "@ros/core";
import { SupabaseStore, createServiceClient } from "@ros/db";
import { applyToJob, detectBlockers, waitForBrowsersClosed } from "../../../packages/workers/src/apply/index.ts";
import { draftEssayAnswer } from "../../../packages/workers/src/apply/essays.ts";
import { setTracking } from "../src/lib/tracking";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const RESUMES = join(ROOT, "resumes/evidence/private/resume_system/01_Child_Resumes");
const SHOTS = join(ROOT, "resumes/evidence/private/shots");
const DRAFTS = join(ROOT, "resumes/evidence/private/drafts");
const ABOUT = join(ROOT, "resumes/evidence/private/about_me.md");
const MASTER = join(ROOT, "resumes/evidence/private/resume_system/01_Child_Resumes/PM_Resume.docx");

// ---- args / env (secrets are read into process.env and never printed)
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const SUBMIT = flag("submit");
const LIMIT = Number(opt("limit") ?? 5);
const VERIFIED = new Set((opt("verify") ?? "").split(",").filter(Boolean)) as Set<AtsKind>;
if (flag("headed")) process.env.ROS_HEADED = "1";

for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|ANTHROPIC_API_KEY)=(.*)$/);
  if (m) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
}

// ---- resume helpers
const docxXml = (f: string) => execFileSync("unzip", ["-p", f, "word/document.xml"], { maxBuffer: 20_000_000 }).toString("utf8");
const text = (xml: string) => [...xml.matchAll(/<w:t(?:\s[^>]*)?>(.*?)<\/w:t>/gs)].map((m) => m[1]).join("");

function unconfirmedText(docx: string): string[] {
  const out: string[] = [];
  for (const run of docxXml(docx).match(/<w:r[ >].*?<\/w:r>/gs) ?? []) {
    if (/<w:highlight w:val="[^"]+"/.test(run) || /<w:shd [^>]*w:fill="FFFF00"/.test(run)) { const t = text(run).trim(); if (t) out.push(t); }
  }
  return out;
}

function readProfile() {
  const paras = (docxXml(MASTER).match(/<w:p[ >].*?<\/w:p>/gs) ?? []).map(text).filter((t) => t.trim());
  const name = (paras[0] ?? "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  const contact = paras[1] ?? "";
  const email = contact.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0] ?? "";
  const phone = contact.match(/\+?\d[\d .()-]{8,}\d/)?.[0]?.trim();
  const location = contact.replace(email, "").replace(phone ?? "", "").trim() || undefined;
  if (!name || !email) throw new Error("Could not read name/email from the PM_Resume.docx header");
  return { name, email, phone, location, education: [] as string[] };
}

function pickResume(role: string, title: string): { base: string; pdf: string; docx: string } {
  const t = title.toLowerCase();
  const base =
    /product manager|product management|\bpm\b/.test(t) || role === "product_management" ? "PM"
    : role === "founders_office" ? "Founders_Office"
    : role === "product_marketing" || role === "gtm_strategy" || role === "growth_brand" || /gtm|go-to-market|marketing|growth/.test(t) ? "GTM"
    : "Strategy";
  return { base, pdf: join(RESUMES, `${base}_Resume.pdf`), docx: join(RESUMES, `${base}_Resume.docx`) };
}

const stamp = () => new Date().toISOString().slice(0, 10);

async function main() {
  if (!existsSync(RESUMES)) throw new Error(`Resumes not found at ${RESUMES}`);
  const store = new SupabaseStore(createServiceClient());
  const profile = readProfile();
  console.log(`Candidate: ${profile.name} <${profile.email}>  Mode: ${SUBMIT ? "LIVE (supervised)" : "DRY RUN (no submit)"}\n`);

  const { data, error } = await store.sb.from("jobs").select("id,tenant_id,user_id,stage,normalized").eq("normalized->tracking->>status", "queued").order("score_total", { ascending: false, nullsFirst: false }).limit(200);
  if (error) throw new Error(`queue query failed: ${error.message}`);
  const queue = (data ?? []) as Array<{ id: string; tenant_id: string; user_id: string; stage: string; normalized: Record<string, any> }>;
  console.log(`${queue.length} job(s) in the auto-apply queue.`);

  let confirmEach = !flag("yes-all");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let done = 0;
  try {
    for (const j of queue) {
      if (done >= LIMIT) { console.log(`Limit of ${LIMIT} reached.`); break; }
      const ctx = { tenantId: j.tenant_id, userId: j.user_id };
      const label = `${j.normalized.company} — ${j.normalized.title}`;
      const app = await store.getApplicationByJob(ctx, j.id);
      if (app?.confirmed) { await setTracking(store, ctx, j.id, { status: "applied" }); console.log(`✓ ${label}: already applied`); continue; }
      if (j.stage === "needs_human") { console.log(`– ${label}: waiting on you (see Inbox)`); continue; }
      if (app?.status === "unverified") { console.log(`– ${label}: earlier submit unverified; check your email/portal, not retrying`); continue; }
      if (app?.status === "dry_run" && !SUBMIT) { console.log(`– ${label}: already dry-run checked (use --submit to apply)`); continue; }

      const resume = pickResume(j.normalized.roleCategory ?? "other", j.normalized.title ?? "");
      const unconfirmed = unconfirmedText(resume.docx);
      if (SUBMIT) {
        const policy = AutomationPolicy.parse((await store.getPreferences(ctx)).policy);
        if (!(policy.mode === "live" && policy.autoApply)) throw new Error("Live mode is off. In Settings, set automation to live with auto-apply on, then re-run.");
        if (unconfirmed.length) throw new Error(`${resume.base} resume has unconfirmed (highlighted) text: ${unconfirmed.map((t) => `"${t}"`).join(", ")}. Confirm or remove it, re-export the PDF, then re-run.`);
        if (!VERIFIED.has(j.normalized.atsKind)) console.log(`  note: ${j.normalized.atsKind} is not in --verify; this one will run as a dry run.`);
      } else if (unconfirmed.length) console.log(`  warning: ${resume.base} resume still has unconfirmed text (${unconfirmed.length} item(s)); live submit will be refused until fixed.`);

      console.log(`→ ${label} [${j.normalized.atsKind}] using ${resume.base} resume`);
      const { data: prof } = await store.sb.from("profiles").select("application_profile").eq("tenant_id", ctx.tenantId).eq("user_id", ctx.userId).maybeSingle();
      const ap = (prof?.application_profile ?? {}) as { eligibility?: Record<string, unknown>; linkedin?: string; answers?: Array<{ match: string; text: string; pick?: string }> };
      const eligibility = ap.eligibility;
      mkdirSync(SHOTS, { recursive: true });
      const rep = await applyToJob(store, ctx, j.id, {
        profile: { ...profile, eligibility: eligibility as never, linkedin: ap.linkedin, answers: ap.answers }, resumePdfPath: resume.pdf, keepOpen: flag("keep-open"),
        draftEssay: async (q) => {
          mkdirSync(DRAFTS, { recursive: true });
          const file = join(DRAFTS, `${j.id}.json`);
          const saved: Record<string, { text: string; approved: boolean }> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
          if (!saved[q.question]) {
            const about = `${readFileSync(ABOUT, "utf8")}\n\n<resume>\n${text(docxXml(resume.docx))}\n</resume>`;
            const t = await draftEssayAnswer({ ...q, about });
            if (!t) return null;
            // AI-restricted applications keep the draft for you to rewrite; others are used as drafted.
            saved[q.question] = { text: t, approved: !q.aiRestricted };
            writeFileSync(file, JSON.stringify(saved, null, 2));
          }
          const d = saved[q.question]!;
          return { text: d.text, approved: d.approved && !q.aiRestricted };
        },
        onCaptcha: async (page) => {
          if (!flag("headed")) return false;
          console.log("  A CAPTCHA is showing. Solve it in the browser window (waiting up to 5 minutes)...");
          for (let k = 0; k < 100; k++) { await page.waitForTimeout(3000); if (!(await detectBlockers(page)).captcha) return true; }
          return false;
        },
        afterFill: async (page) => { await page.screenshot({ path: join(SHOTS, `${j.id}.png`), fullPage: true }); }, verifiedAdapters: SUBMIT ? VERIFIED : new Set(),
        beforeSubmit: async (info) => {
          if (!confirmEach) return true;
          const a = (await rl.question(`  Submit to ${info.company} — ${info.title}? [y]es / [N]o / [a]ll remaining: `)).trim().toLowerCase();
          if (a === "a") { confirmEach = false; return true; }
          return a === "y" || a === "yes";
        },
      });
      done++;

      const note = (m: string) => `[auto-apply ${stamp()}] ${m}`;
      const existing = String(j.normalized.tracking?.notes ?? "");
      const withNote = (m: string) => (existing ? `${existing}\n` : "") + note(m);
      switch (rep.outcome) {
        case "submitted_confirmed":
          await setTracking(store, ctx, j.id, { status: "applied", notes: withNote("Submitted; confirmation page text seen.") });
          console.log("  ✓ submitted and confirmed → Ready to contact"); break;
        case "already_applied":
          await setTracking(store, ctx, j.id, { status: "applied" }); console.log("  ✓ already applied"); break;
        case "dry_run": case "live_gated":
          await setTracking(store, ctx, j.id, { notes: withNote(`Form filled OK (${rep.filled.join(", ")}). Not submitted.`) });
          console.log(`  · form filled (${rep.filled.join(", ")}); not submitted`); break;
        case "submitted_unverified":
          await setTracking(store, ctx, j.id, { notes: withNote("Submit clicked but no confirmation seen. Check email/portal. Will not retry.") });
          console.log("  ! submit clicked, confirmation NOT seen; not marked applied"); break;
        default:
          await setTracking(store, ctx, j.id, { status: "saved", notes: withNote(`Auto-apply could not finish (${rep.outcome}): ${rep.result.exception?.detail ?? "see Inbox"}. Apply manually.`) });
          console.log(`  ✗ ${rep.outcome}: ${rep.result.exception?.detail ?? "see Inbox"} → moved back to Saved`);
      }
    }
  } finally { rl.close(); }
  console.log(`\nDone. Processed ${done} job(s).`);
  if (flag("keep-open")) {
    console.log("Filled forms are open in browser windows for you. Review, finish anything missing, and submit yourself. Close the windows when done.");
    await waitForBrowsersClosed();
  }
}

main().catch((e) => { console.error(`\nStopped: ${e instanceof Error ? e.message : e}`); process.exit(1); });
