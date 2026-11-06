import { z } from "zod";
import { AutomationPolicy, IngestRequest, JobStage, Preferences, type IngestResponse } from "@ros/core";
import { getStoreAsync } from "./store";
import { enqueueIngestion } from "./enqueue";
import { err, json, UUID_RE, withAuth } from "./http";

const MAX_BODY_BYTES = 1_000_000;
const MAX_TEXT_CHARS = 200_000;

async function readJson(req: Request): Promise<{ ok: true; body: unknown } | { ok: false; res: Response }> {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return { ok: false, res: err(413, "payload_too_large") };
  try { return { ok: true, body: raw ? JSON.parse(raw) : {} }; } catch { return { ok: false, res: err(400, "invalid_json") }; }
}

// POST /api/ingest -> accepts, persists, returns the ingestion id immediately, then nudges the pipeline.
export const postIngest = withAuth(async (req, ctx) => {
  const b = await readJson(req);
  if (!b.ok) return b.res;
  const parsed = IngestRequest.safeParse(b.body);
  if (!parsed.success) return err(400, "invalid_request", parsed.error.flatten());
  if ((parsed.data.text?.length ?? 0) > MAX_TEXT_CHARS) return err(413, "text_too_large");

  const headerKey = req.headers.get("idempotency-key")?.slice(0, 200);
  const request = headerKey && !parsed.data.idempotencyKey ? { ...parsed.data, idempotencyKey: headerKey } : parsed.data;

  const store = (await getStoreAsync());
  const row = await store.createIngestion(ctx, request);
  // Store.createIngestion doesn't report "created vs existing"; an existing ingestion already has its accepted event.
  const isNew = row.status === "accepted" && (await store.listEvents(ctx, { entityId: row.id, kind: "ingestion.accepted", limit: 1 })).length === 0;
  if (isNew) {
    await store.logEvent(ctx, "ingestion.accepted", "ingestion", row.id, { source: request.source });
    // Never fail the request because the pipeline trigger is down: the poller claims 'accepted' rows.
    const r = await enqueueIngestion(ctx, row.id);
    if (r.outcome === "failed" || r.outcome === "timeout")
      await store.logEvent(ctx, "ingestion.enqueue_" + r.outcome, "ingestion", row.id, { error: r.error ?? null });
  }
  const body: IngestResponse = { ingestionId: row.id, status: "accepted", duplicateOf: null };
  return json(body, 202);
});

export const getIngestion = (id: string) => withAuth(async (_req, ctx) => {
  if (!UUID_RE.test(id)) return err(400, "invalid_id");
  const store = (await getStoreAsync());
  const ing = await store.getIngestion(ctx, id);
  if (!ing) return err(404, "not_found");
  const job = ing.jobId ? await store.getJob(ctx, ing.jobId) : null;
  return json({ ingestion: { id: ing.id, status: ing.status, jobId: ing.jobId, error: ing.error, attempts: ing.attempts, createdAt: ing.createdAt }, job });
});

export const getPipeline = withAuth(async (_req, ctx) => {
  const store = (await getStoreAsync());
  const [counts, open] = await Promise.all([store.pipelineCounts(ctx), store.listExceptions(ctx, true)]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return json({ counts, total, openExceptions: open.length });
});

const JobsQuery = z.object({
  q: z.string().max(200).optional(),
  stage: JobStage.optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const getJobs = withAuth(async (req, ctx) => {
  const sp = Object.fromEntries(new URL(req.url).searchParams);
  const p = JobsQuery.safeParse(sp);
  if (!p.success) return err(400, "invalid_query", p.error.flatten());
  const jobs = await (await getStoreAsync()).searchJobs(ctx, { text: p.data.q, stage: p.data.stage, minScore: p.data.minScore, limit: p.data.limit });
  return json({ jobs, count: jobs.length });
});

export const getJob = (id: string) => withAuth(async (_req, ctx) => {
  if (!UUID_RE.test(id)) return err(400, "invalid_id");
  const store = (await getStoreAsync());
  const job = await store.getJob(ctx, id);
  if (!job) return err(404, "not_found");
  const [application, events] = await Promise.all([store.getApplicationByJob(ctx, id), store.listEvents(ctx, { entityId: id, limit: 100 })]);
  return json({ job, application, events });
});

export const getPreferences = withAuth(async (_req, ctx) => json({ preferences: await (await getStoreAsync()).getPreferences(ctx) }));

// Partial update with deep-merge for policy + weights. Switching to live mode needs explicit confirmation.
const PrefsPatch = Preferences.partial().extend({
  policy: AutomationPolicy.partial().optional(),
  weights: Preferences.shape.weights.removeDefault().partial().optional(),
  confirmLive: z.boolean().optional(),
}).strict();

export const putPreferences = withAuth(async (req, ctx) => {
  const b = await readJson(req);
  if (!b.ok) return b.res;
  const p = PrefsPatch.safeParse(b.body);
  if (!p.success) return err(400, "invalid_preferences", p.error.flatten());
  const { confirmLive, policy, weights, ...rest } = p.data;
  const store = (await getStoreAsync());
  const cur = await store.getPreferences(ctx);
  const wantsLive = policy?.mode === "live" && cur.policy.mode !== "live";
  if (wantsLive && !confirmLive) return err(400, "live_mode_requires_confirmation", "send confirmLive:true to switch to live mode");
  const next = await store.setPreferences(ctx, {
    ...rest,
    ...(policy ? { policy: { ...cur.policy, ...policy } } : {}),
    ...(weights ? { weights: { ...cur.weights, ...weights } } : {}),
  } as Partial<Preferences>);
  await store.logEvent(ctx, "preferences.updated", "preferences", null, { keys: Object.keys(p.data).filter((k) => k !== "confirmLive"), liveSwitched: wantsLive });
  return json({ preferences: next });
});

export const getExceptions = withAuth(async (req, ctx) => {
  const open = new URL(req.url).searchParams.get("open") !== "false";
  const exceptions = await (await getStoreAsync()).listExceptions(ctx, open);
  return json({ exceptions, count: exceptions.length });
});
