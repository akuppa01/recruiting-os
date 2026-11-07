import { timingSafeEqual } from "node:crypto";
import { getStoreAsync } from "../../../../lib/store";
import { sweepPending } from "../../../../lib/mvp";
import { allOwners, authorizeInternal, deadlinePriority, internalClients, readOptionalJson, unauthorized, unavailable } from "../../../../lib/internal-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
  const a = Buffer.from(given), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Sweeps ingestions left in `accepted` (e.g. work cut short on a serverless cold stop). Vercel Cron sends CRON_SECRET as a bearer token.
export async function GET(req: Request) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const r = await sweepPending(await getStoreAsync(), 20, 45000);
  return Response.json(r);
}

// Daily processing batch (n8n workflow B). Recovers crashed work, then ENQUEUES tasks and returns; it does no processing itself.
//  - qualify: jobs still at stage 'normalized'
//  - tailor:  qualified jobs scoring >= minScore with no resume version yet (AI work, so deliberately score-gated)
//  - apply:   ONLY jobs the user explicitly moved to the auto-apply queue (tracking.status === 'queued')
// body: { minScore?: number }
export async function POST(req: Request) {
  if (!authorizeInternal(req)) return unauthorized();
  const c = internalClients();
  if (!c) return unavailable("Supabase is not configured");
  const body = await readOptionalJson(req);
  const minScore = typeof body.minScore === "number" ? body.minScore : 65;
  const reaped = await c.queue.reapExpired();
  const out = { reaped, qualify: 0, tailor: 0, apply: 0, alreadyQueued: 0 };
  const owners = await allOwners(c.sb);
  for (const ctx of owners) {
    const own = { tenant_id: ctx.tenantId, user_id: ctx.userId };
    const [jobs, resumes] = await Promise.all([
      c.sb.from("jobs").select("id,stage,score_total,normalized").match(own).in("stage", ["normalized", "qualified", "applying"]).limit(200),
      c.sb.from("resume_versions").select("job_id").match(own).limit(5000),
    ]);
    if (jobs.error) throw new Error(`process: ${jobs.error.message}`);
    const haveResume = new Set((resumes.data ?? []).map((r: { job_id: string }) => r.job_id));
    for (const j of (jobs.data ?? []) as Array<{ id: string; stage: string; score_total: number | null; normalized: { deadline?: string | null; tracking?: { status?: string } } | null }>) {
      const pri = deadlinePriority(j.normalized?.deadline);
      let kind: "apply" | "qualify" | "tailor" | null = null, base = 0;
      if (j.normalized?.tracking?.status === "queued") { kind = "apply"; base = 60; }
      else if (j.stage === "normalized") { kind = "qualify"; base = 10; }
      else if (j.stage === "qualified" && (j.score_total ?? 0) >= minScore && !haveResume.has(j.id)) { kind = "tailor"; base = 20; }
      if (!kind) continue;
      const r = await c.queue.enqueue(ctx, { kind, idempotencyKey: `${kind}:${j.id}`, payload: { jobId: j.id }, priority: base + pri });
      if (r.created) out[kind]++; else out.alreadyQueued++;
    }
  }
  return Response.json({ ...out, owners: owners.length });
}
