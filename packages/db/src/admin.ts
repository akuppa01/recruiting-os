// Usage metering / cost tracking, feature flags, user data export and deletion (A5).
// Kept outside the core Store interface (no contract change needed); both implementations are tested the same way.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Ctx } from "@ros/core";
import { randomUUID } from "node:crypto";
import { InMemoryStore } from "./memory.js";
import { createServiceClient } from "./supabase.js";

export interface UsageInput { metric: string; quantity?: number; costUsd?: number; model?: string; ref?: string }
export interface UsageSummary { byMetric: Record<string, { quantity: number; costUsd: number; events: number }>; totalCostUsd: number }
export interface UserExport { exportedAt: string; ctx: Ctx; tables: Record<string, unknown[]> }
export type DeleteCounts = Record<string, number>;

export interface AdminOps {
  recordUsage(ctx: Ctx, u: UsageInput): Promise<void>;
  usageSummary(ctx: Ctx, sinceIso?: string): Promise<UsageSummary>;
  isEnabled(ctx: Ctx, flag: string): Promise<boolean>;
  setFlag(ctx: Ctx, flag: string, enabled: boolean): Promise<void>;
  exportUserData(ctx: Ctx): Promise<UserExport>;
  /** Irreversibly deletes the user's rows in this tenant (+ storage objects on Supabase). `confirm` must equal ctx.userId. */
  deleteUserData(ctx: Ctx, confirm: string): Promise<DeleteCounts>;
}

/** Defaults when no per-user row exists. Risky automation is OFF by default. */
export const DEFAULT_FLAGS: Record<string, boolean> = {
  auto_apply: false,
  auto_outreach: false,
  proof_of_work: true,
  company_research: true,
  push_notifications: true,
  beta_onboarding_wizard: true,
};

/**
 * Cost estimate from caller-supplied per-million-token prices. There is deliberately NO built-in price table:
 * prices change and must come from Anthropic's current pricing page. Returns null when pricing is unknown,
 * so callers record tokens with cost 0 rather than a made-up number.
 */
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number,
  pricing: Record<string, { inputPerM: number; outputPerM: number }>): number | null {
  const p = pricing[model];
  if (!p) return null;
  return (inputTokens / 1e6) * p.inputPerM + (outputTokens / 1e6) * p.outputPerM;
}

/** Records LLM token usage as two metered rows (+ cost on the output row when pricing is known). */
export async function recordLlmUsage(admin: AdminOps, ctx: Ctx, a: {
  model: string; inputTokens: number; outputTokens: number; ref?: string;
  pricing?: Record<string, { inputPerM: number; outputPerM: number }>;
}) {
  const cost = a.pricing ? estimateCostUsd(a.model, a.inputTokens, a.outputTokens, a.pricing) : null;
  await admin.recordUsage(ctx, { metric: "llm.input_tokens", quantity: a.inputTokens, model: a.model, ref: a.ref });
  await admin.recordUsage(ctx, { metric: "llm.output_tokens", quantity: a.outputTokens, costUsd: cost ?? 0, model: a.model, ref: a.ref });
}

const same = (a: Ctx, b: Ctx) => a.tenantId === b.tenantId && a.userId === b.userId;
const summarize = (rows: Array<{ metric: string; quantity: number; costUsd: number }>): UsageSummary => {
  const byMetric: UsageSummary["byMetric"] = {};
  let total = 0;
  for (const r of rows) {
    const m = (byMetric[r.metric] ??= { quantity: 0, costUsd: 0, events: 0 });
    m.quantity += r.quantity; m.costUsd += r.costUsd; m.events++; total += r.costUsd;
  }
  return { byMetric, totalCostUsd: total };
};

// -------------------------------------------------------------------------------- in-memory
export class InMemoryAdmin implements AdminOps {
  usage: Array<{ ctx: Ctx; metric: string; quantity: number; costUsd: number; model: string | null; ref: string | null; createdAt: string }> = [];
  flags = new Map<string, boolean>();
  constructor(readonly store: InMemoryStore) {}

  async recordUsage(ctx: Ctx, u: UsageInput) {
    this.usage.push({ ctx, metric: u.metric, quantity: u.quantity ?? 1, costUsd: u.costUsd ?? 0, model: u.model ?? null, ref: u.ref ?? null, createdAt: new Date().toISOString() });
  }
  async usageSummary(ctx: Ctx, sinceIso?: string) {
    return summarize(this.usage.filter((r) => same(r.ctx, ctx) && (!sinceIso || r.createdAt >= sinceIso)));
  }
  async isEnabled(ctx: Ctx, flag: string) { return this.flags.get(`${ctx.tenantId}:${ctx.userId}:${flag}`) ?? DEFAULT_FLAGS[flag] ?? false; }
  async setFlag(ctx: Ctx, flag: string, enabled: boolean) { this.flags.set(`${ctx.tenantId}:${ctx.userId}:${flag}`, enabled); }

  private owned<T extends { ctx: Ctx }>(m: Map<string, T>, ctx: Ctx) { return [...m.values()].filter((r) => same(r.ctx, ctx)); }

  async exportUserData(ctx: Ctx): Promise<UserExport> {
    const s = this.store;
    return {
      exportedAt: new Date().toISOString(), ctx,
      tables: {
        preferences: [await s.getPreferences(ctx)],
        ingestions: this.owned(s.ingestions, ctx), jobs: this.owned(s.jobs, ctx), applications: this.owned(s.applications, ctx),
        resume_versions: this.owned(s.resumes, ctx), exceptions: this.owned(s.exceptions, ctx), companies: this.owned(s.companies, ctx),
        contacts: this.owned(s.contacts, ctx), outreach_messages: this.owned(s.outreach, ctx),
        events: s.events.filter((e) => e.tenantId === ctx.tenantId && e.userId === ctx.userId),
        external_actions: s.externalActions.filter((a) => same(a.ctx, ctx)),
        usage_events: this.usage.filter((r) => same(r.ctx, ctx)),
        feature_flags: [...this.flags.entries()].filter(([k]) => k.startsWith(`${ctx.tenantId}:${ctx.userId}:`)).map(([k, v]) => ({ flag: k.split(":").slice(2).join(":"), enabled: v })),
      },
    };
  }

  async deleteUserData(ctx: Ctx, confirm: string): Promise<DeleteCounts> {
    if (confirm !== ctx.userId) throw new Error("deleteUserData: confirm must equal the user id");
    const s = this.store;
    const counts: DeleteCounts = {};
    const purge = (name: string, m: Map<string, { ctx: Ctx }>) => {
      let n = 0;
      for (const [k, v] of m) if (same(v.ctx, ctx)) { m.delete(k); n++; }
      counts[name] = n;
    };
    purge("outreach_messages", s.outreach); purge("contacts", s.contacts); purge("companies", s.companies);
    purge("applications", s.applications); purge("resume_versions", s.resumes); purge("jobs", s.jobs);
    purge("ingestions", s.ingestions); purge("exceptions", s.exceptions);
    const ev = s.events.length; s.events = s.events.filter((e) => !(e.tenantId === ctx.tenantId && e.userId === ctx.userId)); counts.events = ev - s.events.length;
    const ea = s.externalActions.length; s.externalActions = s.externalActions.filter((a) => !same(a.ctx, ctx)); counts.external_actions = ea - s.externalActions.length;
    const us = this.usage.length; this.usage = this.usage.filter((r) => !same(r.ctx, ctx)); counts.usage_events = us - this.usage.length;
    let f = 0; for (const k of [...this.flags.keys()]) if (k.startsWith(`${ctx.tenantId}:${ctx.userId}:`)) { this.flags.delete(k); f++; } counts.feature_flags = f;
    counts.preferences = s.prefs.delete(`${ctx.tenantId}:${ctx.userId}`) ? 1 : 0;
    return counts;
  }
}

// -------------------------------------------------------------------------------- supabase
const scope = (c: Ctx) => ({ tenant_id: c.tenantId, user_id: c.userId });
const EXPORT_TABLES: Array<[string, string]> = [
  ["profiles", "*"], ["automation_policies", "*"], ["ingestions", "*"], ["jobs", "*"], ["companies", "*"], ["contacts", "*"],
  ["resume_versions", "*"], ["cover_letters", "*"], ["applications", "*"], ["evidence_items", "*"], ["outreach_messages", "*"],
  ["events", "*"], ["exceptions", "*"], ["dead_letters", "*"], ["external_actions", "*"], ["usage_events", "*"], ["feature_flags", "*"],
  ["api_tokens", "id,label,created_at,last_used_at,revoked_at"], // never export token hashes
];
// children before parents
const DELETE_ORDER = ["outreach_messages", "contacts", "companies", "applications", "resume_versions", "cover_letters", "jobs",
  "dead_letters", "ingestions", "evidence_items", "events", "exceptions", "external_actions", "usage_events", "feature_flags",
  "api_tokens", "automation_policies", "profiles"];
const BUCKETS = ["resumes", "ingest-files"];

export class SupabaseAdmin implements AdminOps {
  constructor(readonly sb: SupabaseClient = createServiceClient()) {}

  async recordUsage(ctx: Ctx, u: UsageInput) {
    const { error } = await this.sb.from("usage_events").insert({ ...scope(ctx), metric: u.metric, quantity: u.quantity ?? 1, cost_usd: u.costUsd ?? 0, model: u.model ?? null, ref: u.ref ?? null });
    if (error) throw new Error("recordUsage: " + error.message);
  }
  async usageSummary(ctx: Ctx, sinceIso?: string) {
    let q = this.sb.from("usage_events").select("metric,quantity,cost_usd").match(scope(ctx));
    if (sinceIso) q = q.gte("created_at", sinceIso);
    const { data, error } = await q;
    if (error) throw new Error("usageSummary: " + error.message);
    return summarize((data ?? []).map((r) => ({ metric: r.metric, quantity: Number(r.quantity), costUsd: Number(r.cost_usd) })));
  }
  async isEnabled(ctx: Ctx, flag: string) {
    const { data, error } = await this.sb.from("feature_flags").select("enabled").match(scope(ctx)).eq("flag", flag).maybeSingle();
    if (error) throw new Error("isEnabled: " + error.message);
    return data ? !!data.enabled : DEFAULT_FLAGS[flag] ?? false;
  }
  async setFlag(ctx: Ctx, flag: string, enabled: boolean) {
    const { error } = await this.sb.from("feature_flags").upsert({ ...scope(ctx), flag, enabled }, { onConflict: "tenant_id,user_id,flag" });
    if (error) throw new Error("setFlag: " + error.message);
  }
  async exportUserData(ctx: Ctx): Promise<UserExport> {
    const tables: Record<string, unknown[]> = {};
    for (const [t, cols] of EXPORT_TABLES) {
      const { data, error } = await this.sb.from(t).select(cols).match(scope(ctx));
      if (error) throw new Error(`exportUserData(${t}): ${error.message}`);
      tables[t] = data ?? [];
    }
    return { exportedAt: new Date().toISOString(), ctx, tables };
  }
  async deleteUserData(ctx: Ctx, confirm: string): Promise<DeleteCounts> {
    if (confirm !== ctx.userId) throw new Error("deleteUserData: confirm must equal the user id");
    const counts: DeleteCounts = {};
    for (const t of DELETE_ORDER) {
      const { data, error } = await this.sb.from(t).delete().match(scope(ctx)).select("*");
      if (error) throw new Error(`deleteUserData(${t}): ${error.message}`);
      counts[t] = data?.length ?? 0;
    }
    let objs = 0;
    for (const b of BUCKETS) {
      const list = await this.sb.storage.from(b).list(ctx.userId, { limit: 1000 });
      const paths = (list.data ?? []).filter((o) => o.name).map((o) => `${ctx.userId}/${o.name}`);
      if (paths.length) { const rm = await this.sb.storage.from(b).remove(paths); if (rm.error) throw new Error(`deleteUserData(storage ${b}): ${rm.error.message}`); objs += paths.length; }
    }
    counts.storage_objects = objs;
    return counts;
  }
}

export const newId = () => randomUUID();
