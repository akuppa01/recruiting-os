// Shared helpers for /api/internal/* batch endpoints (called by n8n or Vercel Cron, never by browsers).
// These endpoints only ENQUEUE durable tasks and return. Long-running work (browser automation, discovery sweeps) runs in workers.
import { timingSafeEqual } from "node:crypto";
import type { Ctx } from "@ros/core";
import { SupabaseTaskQueue, createServiceClient, hasSupabaseEnv } from "@ros/db";

export type ServiceClient = ReturnType<typeof createServiceClient>;

const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** `Authorization: Bearer <CRON_SECRET>` (Vercel Cron, n8n) or `x-ros-internal-secret: <CRON_SECRET>`. Fails closed when the secret is unset. */
export function authorizeInternal(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const header = req.headers.get("x-ros-internal-secret");
  return (!!bearer && safeEq(bearer, secret)) || (!!header && safeEq(header, secret));
}

export const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401 });
export const unavailable = (why: string) => Response.json({ error: "unavailable", detail: why }, { status: 503 });

export function internalClients(): { sb: ServiceClient; queue: SupabaseTaskQueue } | null {
  if (!hasSupabaseEnv()) return null;
  const sb = createServiceClient();
  return { sb, queue: new SupabaseTaskQueue(sb) };
}

/** Every user (tenant + user) that has a profile. Multi-user ready: one task set per owner. */
export async function allOwners(sb: ServiceClient): Promise<Ctx[]> {
  const { data, error } = await sb.from("profiles").select("tenant_id,user_id").limit(1000);
  if (error) throw new Error(`allOwners: ${error.message}`);
  return (data ?? []).map((r: { tenant_id: string; user_id: string }) => ({ tenantId: r.tenant_id, userId: r.user_id }));
}

/** Idempotency slots: re-running the same batch in the same slot never creates duplicate tasks. */
export const daySlot = (d: Date = new Date()) => d.toISOString().slice(0, 10);
export const hourSlot = (d: Date = new Date()) => d.toISOString().slice(0, 13);

/** Higher priority for jobs whose application deadline is close. */
export function deadlinePriority(deadline: string | null | undefined, now: Date = new Date()): number {
  if (!deadline) return 0;
  const days = (Date.parse(deadline) - now.getTime()) / 86_400_000;
  if (Number.isNaN(days) || days < -1) return 0;
  return days <= 3 ? 80 : days <= 7 ? 50 : days <= 14 ? 20 : 0;
}

export async function readOptionalJson(req: Request): Promise<Record<string, unknown>> {
  try { const t = await req.text(); return t ? (JSON.parse(t) as Record<string, unknown>) : {}; } catch { return {}; }
}
