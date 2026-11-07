// Unattended cloud worker. Runs on a GitHub Actions runner (no dependence on the user's Mac):
//   discover (public feeds + emails pushed by n8n) -> ingest + qualify -> enqueue apply tasks under policy -> run apply tasks -> usage + one notification.
//
//   tsx apps/web/scripts/cloud-worker.ts --once [--dry-run] [--max-minutes 25] [--skip-discovery]
//   tsx apps/web/scripts/cloud-worker.ts --test-notification
//
// Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY (optional), NTFY_TOPIC (optional), ROS_APP_URL (optional).
// The repo is PUBLIC, so logs are public: only ids, company, title, ATS, outcome codes, counts and durations are printed.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LIMITS, type Ctx, type Task } from "@ros/core";
import { SupabaseStore, SupabaseTaskQueue, createServiceClient, createSpendReader } from "@ros/db";
import { SupabaseFormTemplateStore } from "../../../packages/workers/src/apply/templates.ts";
import { buildAdapters } from "../../../packages/workers/src/discovery/registry.ts";
import { SupabaseSourceHealthStore } from "../../../packages/workers/src/discovery/health.ts";
import { createNotifierFromEnv, notify } from "../../../packages/workers/src/notify/index.ts";
import {
  MissingAssetsError, StorageDraftCache, SupabaseUsageRecorder, buildCandidate, buildNotification, createApplyHandler, createLogger,
  discoveryPhase, downloadAssets, enqueueApplyPhase, enrichFromAts, resolveAnswerFiles, runApplyPhase,
  type ApplyResultRecord, type ApplicantBundle, type PushedEmail, type RunSummary, type StorageLike,
} from "../../../packages/workers/src/cloud/index.ts";
import { BOARDS } from "../src/lib/discover-config";
import { setTracking } from "../src/lib/tracking";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };

// Local runs: fall back to .env.local for variables that are not already set (Actions provides them via secrets).
const localEnv = join(ROOT, ".env.local");
if (existsSync(localEnv)) {
  for (const line of readFileSync(localEnv, "utf8").split("\n")) {
    const m = line.match(/^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|ANTHROPIC_API_KEY|NTFY_TOPIC)=(.*)$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
  }
}

const rootLog = createLogger();
const asEmail = (t: Task): PushedEmail | null => {
  const e = (t.payload as { email?: Record<string, unknown> }).email;
  if (!e || typeof e.from !== "string" || typeof e.messageId !== "string") return null;
  return { taskId: t.id, email: { from: e.from, subject: String(e.subject ?? ""), text: String(e.text ?? ""), date: typeof e.date === "string" ? e.date : undefined, messageId: e.messageId, threadId: typeof e.threadId === "string" ? e.threadId : undefined } };
};

async function main() {
  const notifier = createNotifierFromEnv();

  if (flag("test-notification")) {
    if (notifier.name === "dry_run") { rootLog.line("NTFY_TOPIC is not set: no notification channel configured"); process.exit(2); }
    const r = await notifier.send({ kind: "integration_issue", title: "Recruiting OS test notification", body: "This is a TEST message from the cloud worker. If you can read it, phone notifications work.", priority: "default" });
    rootLog.line(`test notification via ${r.adapter}: ${r.status}${r.detail ? ` (${r.detail})` : ""}`);
    process.exit(r.status === "succeeded" ? 0 : 1);
  }

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  const sb = createServiceClient();
  const store = new SupabaseStore(sb);
  const queue = new SupabaseTaskQueue(sb);
  const health = new SupabaseSourceHealthStore(sb);
  const usage = new SupabaseUsageRecorder(sb);
  const templates = new SupabaseFormTemplateStore(sb);
  const spend = createSpendReader(sb);

  const dryRun = flag("dry-run");
  const maxMinutes = Number(opt("max-minutes") ?? 25);
  const deadline = new Date(Date.now() + maxMinutes * 60_000);
  const workerId = `gha-${process.env.GITHUB_RUN_ID ?? "local"}-${process.pid}`;
  const host = process.env.GITHUB_ACTIONS ? "github-actions" : hostname().replace(/[^a-z0-9-]/gi, "").slice(0, 20);
  rootLog.line(`cloud worker ${workerId} starting; mode=${dryRun ? "dry-run" : "per saved policy"}; budget ${maxMinutes} min`);

  const reaped = await queue.reapExpired();
  if (reaped) rootLog.line(`recovered ${reaped} task(s) with expired leases`);

  const { data: profiles, error } = await sb.from("profiles").select("tenant_id,user_id,application_profile");
  if (error) throw new Error(`could not read profiles: ${error.message}`);
  if (!profiles?.length) { rootLog.line("no profiles found; nothing to do"); return; }

  // Emails pushed by n8n arrive as 'discover' tasks. Lease once, then hand each user their own.
  const leased = flag("skip-discovery") ? [] : await queue.lease(workerId, ["discover"], { limit: 100, leaseSeconds: 900 });
  let exitCode = 0;

  for (const p of profiles as Array<{ tenant_id: string; user_id: string; application_profile: Record<string, unknown> | null }>) {
    const ctx: Ctx = { tenantId: p.tenant_id, userId: p.user_id };
    const ap = (p.application_profile ?? {}) as { email?: string; linkedin?: string; eligibility?: Record<string, unknown>; answers?: Array<{ match: string; text: string; pick?: string; file?: string }> };
    const mine = leased.filter((t) => t.ctx.tenantId === ctx.tenantId && t.ctx.userId === ctx.userId);
    try {
      await queue.workerHeartbeat(workerId, { host, kinds: ["discover", "apply"], currentTask: null });

      const assets = await downloadAssets(sb as unknown as StorageLike, ctx.userId, join(tmpdir(), `ros-${ctx.userId.slice(0, 8)}`));
      const { answers, droppedFiles } = resolveAnswerFiles(ap.answers, assets.files);
      const { profile, personal } = buildCandidate(assets.resumes.PM.docx, { ...ap, answers });
      const log = createLogger({ personal });
      if (droppedFiles) log.line(`note: ${droppedFiles} saved file answer(s) have no uploaded asset; those questions will go to the inbox`);
      mkdirSync(assets.dir, { recursive: true });

      const prefs = await store.getPreferences(ctx);
      const pushed = mine.map(asEmail).filter((e): e is PushedEmail => !!e);

      // ---- Phase A: discovery + ingestion
      let discovery;
      if (!flag("skip-discovery")) {
        const by = (ats: string) => BOARDS.filter((b) => b.ats === ats).map((b) => ({ board: b.board, name: b.name }));
        const feedAdapters = buildAdapters({
          boards: { greenhouse: by("greenhouse"), lever: by("lever"), ashby: by("ashby") },
          extraLocations: prefs.locationsPreferred, only: ["greenhouse", "lever", "ashby", "remote_feed"],
        });
        discovery = await discoveryPhase({ store, ctx, prefs, log: log.line, feedAdapters, healthStore: health, pushedEmails: pushed, enrich: (j) => enrichFromAts(j) });
        for (const t of mine) await queue.complete(t.id, workerId, { result: { emails: pushed.length } }).catch(() => undefined);
        await usage.record(ctx, [{ metric: "discovery.jobs_new", quantity: discovery.created, ref: "measured" }]).catch(() => undefined);
        for (const s of discovery.sourceErrors) log.line(`source problem: ${s}`);
      }

      // ---- Phase B: enqueue apply tasks (policy, score threshold, ATS support, daily cap, deadline priority)
      const countAppsToday = async (c: Ctx, since: Date) => {
        const r = await sb.from("applications").select("id", { count: "exact", head: true }).eq("tenant_id", c.tenantId).eq("user_id", c.userId).gte("created_at", since.toISOString());
        if (r.error) throw new Error(`applications count: ${r.error.message}`);
        return r.count ?? 0;
      };
      const enqueue = await enqueueApplyPhase({ store, queue, ctx, prefs, log: log.line, countAppsToday, forceDryRun: dryRun });

      // ---- Phase C: run apply tasks inside the time budget
      const results: ApplyResultRecord[] = [];
      const bundle: ApplicantBundle = { profile, resumes: assets.resumes, aboutPath: assets.aboutPath };
      const handler = createApplyHandler({
        store, usage, templates, drafts: new StorageDraftCache(sb as unknown as StorageLike, ctx.userId),
        bundleFor: async () => bundle,
        tracking: async (c, jobId, patch) => { await setTracking(store, c, jobId, patch as never); },
        uploadEvidence: async (c, jobId, png) => { await sb.storage.from("ingest-files").upload(`${c.userId}/evidence/${jobId}.png`, png, { upsert: true, contentType: "image/png" }); },
        verified: new Set((process.env.ROS_VERIFIED_ADAPTERS ?? "greenhouse").split(",").map((s) => s.trim()).filter(Boolean)) as never,
        limits: DEFAULT_LIMITS, forceDryRun: dryRun, log: log.line, onResult: (r) => results.push(r),
      });
      const ran = await runApplyPhase({ queue, handler, workerId, host, spend, limits: DEFAULT_LIMITS, deadline, log: log.line });

      // ---- Phase D: one notification, only when something noteworthy happened
      const summary: RunSummary = { dryRun, discovery, enqueue, results, failedTasks: ran.failed + ran.budgetSkips + ran.timeouts };
      const n = buildNotification(summary, process.env.ROS_APP_URL);
      if (n) { const r = await notify(store, ctx, notifier, n, { quiet: prefs.policy.quietHours }); log.line(`notification: ${r.status}`); }
      else log.line("notification: none (nothing noteworthy)");
      log.line(`done: ${results.length} application task(s) processed, ${ran.failed} failed`);
    } catch (e) {
      exitCode = 1;
      const msg = e instanceof MissingAssetsError ? e.message : (e instanceof Error ? e.message : String(e));
      rootLog.line(`user ${ctx.userId.slice(0, 8)}: stopped: ${msg.slice(0, 300)}`);
      for (const t of mine) await queue.fail(t.id, workerId, "worker stopped before processing", { retry: true, backoffSeconds: 900 }).catch(() => undefined);
    }
  }
  await queue.workerHeartbeat(workerId, { host, kinds: ["discover", "apply"], currentTask: null }).catch(() => undefined);
  process.exit(exitCode);
}

main().catch((e) => { rootLog.line(`cloud worker stopped: ${e instanceof Error ? e.message.slice(0, 300) : "error"}`); process.exit(1); });
