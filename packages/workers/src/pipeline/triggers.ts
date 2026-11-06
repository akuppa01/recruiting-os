import type { Ctx } from "@ros/core";

/** Matches apps/web/src/lib/enqueue.ts EnqueueFn: (ctx, ingestionId) => Promise<void>. Register with setEnqueue(). */
export type EnqueueFn = (ctx: Ctx, ingestionId: string) => Promise<void>;

/** POST to an n8n webhook. Never loses work: if this fails the ingestion stays `accepted` and the poller picks it up. */
export function makeN8nTrigger(o: { url: string; secret: string; fetchImpl?: typeof fetch }): EnqueueFn {
  return async (ctx, ingestionId) => {
    const r = await (o.fetchImpl ?? fetch)(o.url, { method: "POST", headers: { "content-type": "application/json", "x-ros-secret": o.secret }, body: JSON.stringify({ ingestionId, tenantId: ctx.tenantId, userId: ctx.userId }) });
    if (!r.ok) throw new Error(`n8n webhook HTTP ${r.status}`);
  };
}

export function makeTriggerFromEnv(env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch): EnqueueFn | null {
  if (!env.N8N_BASE_URL || !env.N8N_WEBHOOK_SECRET) return null;
  return makeN8nTrigger({ url: `${env.N8N_BASE_URL.replace(/\/$/, "")}/webhook/ros-ingest`, secret: env.N8N_WEBHOOK_SECRET, fetchImpl });
}
