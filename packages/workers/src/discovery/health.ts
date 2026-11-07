// Source health: honest per-source status. last_success_at only moves on real success; errors are kept, never hidden.
import { createServiceClient } from "@ros/db";
import type { Ctx, SourceHealth, SourceHealthStore, SourceId, SourceRunResult, SourceStatus } from "@ros/core";

export interface SourceHealthRow {
  source: SourceId; status: SourceStatus;
  last_attempt_at: string | null; last_success_at: string | null; last_error: string | null;
  items_last_run: number; items_total: number;
}

/** Pure state transition used by every store implementation. */
export function nextHealth(prev: Partial<SourceHealthRow> | null | undefined, r: SourceRunResult, now: Date = new Date()): SourceHealthRow {
  const ts = now.toISOString();
  const base = { source: r.source, last_attempt_at: ts, items_total: prev?.items_total ?? 0 };
  const lastSuccess = prev?.last_success_at ?? null;
  if (r.notConfigured) return { ...base, status: "not_configured", last_success_at: lastSuccess, last_error: r.notConfigured, items_last_run: 0 };
  if (r.error && r.jobs.length === 0) return { ...base, status: "failed", last_success_at: lastSuccess, last_error: r.error, items_last_run: 0 };
  if (r.error) return { ...base, status: "degraded", last_success_at: ts, last_error: r.error, items_last_run: r.jobs.length, items_total: base.items_total + r.jobs.length };
  return { ...base, status: "ok", last_success_at: ts, last_error: null, items_last_run: r.jobs.length, items_total: base.items_total + r.jobs.length };
}

const toHealth = (r: SourceHealthRow): SourceHealth => ({
  source: r.source, status: r.status, lastAttemptAt: r.last_attempt_at, lastSuccessAt: r.last_success_at,
  lastError: r.last_error, itemsLastRun: r.items_last_run, itemsTotal: r.items_total,
});

export class InMemorySourceHealthStore implements SourceHealthStore {
  private rows = new Map<string, SourceHealthRow>();
  private key = (ctx: Ctx, s: string) => `${ctx.tenantId}|${ctx.userId}|${s}`;
  constructor(private now: () => Date = () => new Date()) {}
  async record(ctx: Ctx, r: SourceRunResult) { this.rows.set(this.key(ctx, r.source), nextHealth(this.rows.get(this.key(ctx, r.source)), r, this.now())); }
  async list(ctx: Ctx) {
    return [...this.rows.entries()].filter(([k]) => k.startsWith(`${ctx.tenantId}|${ctx.userId}|`)).map(([, v]) => toHealth(v));
  }
}

type Sb = ReturnType<typeof createServiceClient>;

/** Backed by public.source_health. Service role bypasses RLS, so EVERY query carries explicit tenant_id + user_id. */
export class SupabaseSourceHealthStore implements SourceHealthStore {
  constructor(private sb: Sb = createServiceClient(), private now: () => Date = () => new Date()) {}
  async record(ctx: Ctx, r: SourceRunResult) {
    const scope = { tenant_id: ctx.tenantId, user_id: ctx.userId };
    const prev = await this.sb.from("source_health").select("*").match({ ...scope, source: r.source }).maybeSingle();
    if (prev.error) throw new Error(`source_health read: ${prev.error.message}`);
    const row = nextHealth(prev.data as Partial<SourceHealthRow> | null, r, this.now());
    const { error } = await this.sb.from("source_health").upsert({ ...scope, ...row }, { onConflict: "tenant_id,user_id,source" });
    if (error) throw new Error(`source_health write: ${error.message}`);
  }
  async list(ctx: Ctx) {
    const { data, error } = await this.sb.from("source_health").select("*").match({ tenant_id: ctx.tenantId, user_id: ctx.userId }).order("source");
    if (error) throw new Error(`source_health list: ${error.message}`);
    return (data as SourceHealthRow[]).map(toHealth);
  }
}
