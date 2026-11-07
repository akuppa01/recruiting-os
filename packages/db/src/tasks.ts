// V3 durable task queue: InMemoryTaskQueue (tests/dev) and SupabaseTaskQueue (production, service role).
// Contract: TaskQueue in @ros/core (v3.ts). Tables: supabase/migrations/0005_v3_pipeline.sql.
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Ctx, EnqueueInput, Task, TaskKind, TaskQueue, TaskStatus } from "@ros/core";
import { createServiceClient } from "./supabase.js";

export type Clock = () => Date;
const UNIQUE_VIOLATION = "23505";

/** Exponential backoff used when the caller does not specify one: 30s, 60s, 120s ... capped at 1h. attempts is 1-based. */
export const defaultBackoffSeconds = (attempts: number) => Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));

const addSeconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000).toISOString();
const iso = (d: Date) => d.toISOString();

export class LeaseLostError extends Error {
  constructor(taskId: string, workerId: string) { super(`lease lost for task ${taskId} (worker ${workerId})`); this.name = "LeaseLostError"; }
}

/** Test/helper view of queue internals that is not part of the TaskQueue contract. */
export interface TaskLogRow { taskId: string; level: "debug" | "info" | "warn" | "error"; message: string; data: Record<string, unknown>; createdAt: string }

// ====================================================================== in-memory
export class InMemoryTaskQueue implements TaskQueue {
  private tasks = new Map<string, Task>();
  private logsByTask = new Map<string, TaskLogRow[]>();
  readonly heartbeats = new Map<string, { host?: string; kinds: TaskKind[]; currentTask: string | null; lastSeen: string }>();
  constructor(private now: Clock = () => new Date()) {}

  private sameOwner(a: Ctx, b: Ctx) { return a.tenantId === b.tenantId && a.userId === b.userId; }

  async enqueue(ctx: Ctx, t: EnqueueInput) {
    for (const x of this.tasks.values()) if (this.sameOwner(x.ctx, ctx) && x.idempotencyKey === t.idempotencyKey) return { task: { ...x }, created: false };
    const task: Task = {
      id: randomUUID(), ctx: { ...ctx }, kind: t.kind, payload: t.payload ?? {}, status: "queued", idempotencyKey: t.idempotencyKey,
      priority: t.priority ?? 0, attempts: 0, maxAttempts: t.maxAttempts ?? 3, runAfter: t.runAfter ?? iso(this.now()),
      leaseUntil: null, workerId: null, lastError: null, result: null, costUsd: 0, createdAt: iso(this.now()),
    };
    this.tasks.set(task.id, task);
    return { task: { ...task }, created: true };
  }

  // JS is single-threaded and this method has no awaits between the read and the write, so a lease is atomic.
  async lease(workerId: string, kinds: TaskKind[], opts: { limit?: number; leaseSeconds?: number } = {}) {
    const limit = opts.limit ?? 1, leaseSeconds = opts.leaseSeconds ?? 60;
    const now = this.now();
    const ready = [...this.tasks.values()].filter((t) => kinds.includes(t.kind) && (
      (t.status === "queued" && new Date(t.runAfter) <= now) || (t.status === "leased" && t.leaseUntil !== null && new Date(t.leaseUntil) < now)
    )).sort((a, b) => b.priority - a.priority || a.runAfter.localeCompare(b.runAfter) || a.createdAt.localeCompare(b.createdAt));
    const out: Task[] = [];
    for (const t of ready) {
      if (out.length >= limit) break;
      if (t.status === "leased" && t.attempts >= t.maxAttempts) { // crashed on its last attempt: dead-letter instead of running again
        t.status = "dead"; t.leaseUntil = null; t.workerId = null; t.lastError = t.lastError ?? "lease expired after final attempt";
        continue;
      }
      t.status = "leased"; t.workerId = workerId; t.leaseUntil = addSeconds(now, leaseSeconds); t.attempts += 1;
      out.push({ ...t });
    }
    return out;
  }

  private owned(taskId: string, workerId: string): Task | null {
    const t = this.tasks.get(taskId);
    return t && t.status === "leased" && t.workerId === workerId ? t : null;
  }

  async heartbeat(taskId: string, workerId: string, extendSeconds = 60) {
    const t = this.owned(taskId, workerId);
    if (!t) return false;
    t.leaseUntil = addSeconds(this.now(), extendSeconds);
    return true;
  }

  async complete(taskId: string, workerId: string, o: { result?: Record<string, unknown>; costUsd?: number } = {}) {
    const t = this.owned(taskId, workerId);
    if (!t) throw new LeaseLostError(taskId, workerId);
    t.status = "done"; t.result = o.result ?? null; t.costUsd += o.costUsd ?? 0; t.leaseUntil = null; t.lastError = null;
  }

  async fail(taskId: string, workerId: string, error: string, o: { retry?: boolean; backoffSeconds?: number; costUsd?: number } = {}) {
    const t = this.owned(taskId, workerId);
    if (!t) throw new LeaseLostError(taskId, workerId);
    const retry = o.retry ?? true;
    t.lastError = error; t.costUsd += o.costUsd ?? 0; t.leaseUntil = null; t.workerId = null;
    if (!retry) t.status = "failed";
    else if (t.attempts >= t.maxAttempts) t.status = "dead";
    else { t.status = "queued"; t.runAfter = addSeconds(this.now(), o.backoffSeconds ?? defaultBackoffSeconds(t.attempts)); }
    return { ...t };
  }

  async reapExpired() {
    const now = this.now();
    let n = 0;
    for (const t of this.tasks.values()) {
      if (t.status !== "leased" || t.leaseUntil === null || new Date(t.leaseUntil) >= now) continue;
      t.lastError = "lease expired (worker crashed or stalled)"; t.leaseUntil = null; t.workerId = null;
      if (t.attempts >= t.maxAttempts) t.status = "dead"; else { t.status = "queued"; t.runAfter = iso(now); }
      n++;
    }
    return n;
  }

  async log(taskId: string, level: TaskLogRow["level"], message: string, data: Record<string, unknown> = {}) {
    const arr = this.logsByTask.get(taskId) ?? [];
    arr.push({ taskId, level, message, data, createdAt: iso(this.now()) });
    this.logsByTask.set(taskId, arr);
  }
  logsFor(taskId: string): TaskLogRow[] { return [...(this.logsByTask.get(taskId) ?? [])]; }

  async get(ctx: Ctx, id: string) {
    const t = this.tasks.get(id);
    return t && this.sameOwner(t.ctx, ctx) ? { ...t } : null;
  }

  async list(ctx: Ctx, q: { kind?: TaskKind; status?: TaskStatus; limit?: number } = {}) {
    return [...this.tasks.values()].filter((t) => this.sameOwner(t.ctx, ctx) && (!q.kind || t.kind === q.kind) && (!q.status || t.status === q.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, q.limit ?? 100).map((t) => ({ ...t }));
  }

  async deadLetters(ctx: Ctx, limit = 50) { return this.list(ctx, { status: "dead", limit }); }

  async workerHeartbeat(workerId: string, info: { host?: string; kinds: TaskKind[]; currentTask?: string | null }) {
    this.heartbeats.set(workerId, { host: info.host, kinds: info.kinds, currentTask: info.currentTask ?? null, lastSeen: iso(this.now()) });
  }
}

// ====================================================================== Supabase
/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const toTask = (r: Row): Task => ({
  id: r.id, ctx: { tenantId: r.tenant_id, userId: r.user_id }, kind: r.kind, payload: r.payload ?? {}, status: r.status,
  idempotencyKey: r.idempotency_key, priority: r.priority, attempts: r.attempts, maxAttempts: r.max_attempts, runAfter: r.run_after,
  leaseUntil: r.lease_until, workerId: r.worker_id, lastError: r.last_error, result: r.result ?? null, costUsd: Number(r.cost_usd ?? 0), createdAt: r.created_at,
});
const fail_ = (op: string, error: { message: string } | null): never => { throw new Error(`SupabaseTaskQueue.${op}: ${error?.message ?? "unknown error"}`); };

/**
 * Production queue. Uses the service role (RLS bypassed): every owner-scoped read/write carries tenant_id + user_id.
 * Concurrency safety needs no RPC: leasing is an optimistic conditional UPDATE keyed on (id, status, attempts),
 * and `attempts` changes on every lease, so two workers can never both win the same row.
 */
export class SupabaseTaskQueue implements TaskQueue {
  private ownerCache = new Map<string, Ctx>();
  constructor(readonly sb: SupabaseClient = createServiceClient(), private now: Clock = () => new Date()) {}

  async enqueue(ctx: Ctx, t: EnqueueInput) {
    const find = async () => {
      const { data, error } = await this.sb.from("tasks").select("*").eq("tenant_id", ctx.tenantId).eq("user_id", ctx.userId).eq("idempotency_key", t.idempotencyKey).maybeSingle();
      if (error) fail_("enqueue.find", error);
      return data ? toTask(data) : null;
    };
    const existing = await find();
    if (existing) return { task: existing, created: false };
    const { data, error } = await this.sb.from("tasks").insert({
      tenant_id: ctx.tenantId, user_id: ctx.userId, kind: t.kind, payload: t.payload ?? {}, idempotency_key: t.idempotencyKey,
      priority: t.priority ?? 0, max_attempts: t.maxAttempts ?? 3, run_after: t.runAfter ?? iso(this.now()),
    }).select("*").single();
    if (error) {
      if (error.code === UNIQUE_VIOLATION) { const again = await find(); if (again) return { task: again, created: false }; }
      fail_("enqueue", error);
    }
    return { task: toTask(data!), created: true };
  }

  async lease(workerId: string, kinds: TaskKind[], opts: { limit?: number; leaseSeconds?: number } = {}) {
    const limit = opts.limit ?? 1, leaseSeconds = opts.leaseSeconds ?? 60;
    const now = this.now(), nowIso = iso(now);
    // Candidate scan (read-only): ready queued tasks, plus leased tasks whose lease already expired.
    const { data, error } = await this.sb.from("tasks").select("*").in("kind", kinds)
      .or(`and(status.eq.queued,run_after.lte.${nowIso}),and(status.eq.leased,lease_until.lt.${nowIso})`)
      .order("priority", { ascending: false }).order("run_after", { ascending: true }).order("created_at", { ascending: true })
      .limit(Math.max(limit * 3, 10));
    if (error) fail_("lease.scan", error);
    const out: Task[] = [];
    for (const c of (data ?? []) as Row[]) {
      if (out.length >= limit) break;
      // Conditional claim: only succeeds if nobody changed the row since we read it (attempts is the version token).
      const claim = this.sb.from("tasks").update(
        c.status === "leased" && c.attempts >= c.max_attempts
          ? { status: "dead", worker_id: null, lease_until: null, last_error: c.last_error ?? "lease expired after final attempt" }
          : { status: "leased", worker_id: workerId, lease_until: addSeconds(now, leaseSeconds), attempts: c.attempts + 1 },
      ).eq("id", c.id).eq("tenant_id", c.tenant_id).eq("user_id", c.user_id).eq("status", c.status).eq("attempts", c.attempts);
      const { data: won, error: e2 } = await claim.select("*");
      if (e2) fail_("lease.claim", e2);
      const row = (won ?? [])[0] as Row | undefined;
      if (row && row.status === "leased") out.push(toTask(row));
    }
    return out;
  }

  private async fetchOwned(taskId: string, workerId: string): Promise<Row | null> {
    const { data, error } = await this.sb.from("tasks").select("*").eq("id", taskId).eq("worker_id", workerId).eq("status", "leased").maybeSingle();
    if (error) fail_("fetchOwned", error);
    return (data as Row | null) ?? null;
  }

  async heartbeat(taskId: string, workerId: string, extendSeconds = 60) {
    const r = await this.fetchOwned(taskId, workerId);
    if (!r) return false;
    const { data, error } = await this.sb.from("tasks").update({ lease_until: addSeconds(this.now(), extendSeconds) })
      .eq("id", taskId).eq("tenant_id", r.tenant_id).eq("user_id", r.user_id).eq("worker_id", workerId).eq("status", "leased").select("id");
    if (error) fail_("heartbeat", error);
    return (data ?? []).length === 1;
  }

  async complete(taskId: string, workerId: string, o: { result?: Record<string, unknown>; costUsd?: number } = {}) {
    const r = await this.fetchOwned(taskId, workerId);
    if (!r) throw new LeaseLostError(taskId, workerId);
    const { data, error } = await this.sb.from("tasks").update({
      status: "done", result: o.result ?? null, cost_usd: Number(r.cost_usd ?? 0) + (o.costUsd ?? 0), lease_until: null, last_error: null,
    }).eq("id", taskId).eq("tenant_id", r.tenant_id).eq("user_id", r.user_id).eq("worker_id", workerId).eq("status", "leased").eq("attempts", r.attempts).select("id");
    if (error) fail_("complete", error);
    if ((data ?? []).length !== 1) throw new LeaseLostError(taskId, workerId);
  }

  async fail(taskId: string, workerId: string, error: string, o: { retry?: boolean; backoffSeconds?: number; costUsd?: number } = {}) {
    const r = await this.fetchOwned(taskId, workerId);
    if (!r) throw new LeaseLostError(taskId, workerId);
    const retry = o.retry ?? true;
    const patch: Row = { last_error: error, cost_usd: Number(r.cost_usd ?? 0) + (o.costUsd ?? 0), lease_until: null, worker_id: null };
    if (!retry) patch.status = "failed";
    else if (r.attempts >= r.max_attempts) patch.status = "dead";
    else { patch.status = "queued"; patch.run_after = addSeconds(this.now(), o.backoffSeconds ?? defaultBackoffSeconds(r.attempts)); }
    const { data, error: e } = await this.sb.from("tasks").update(patch)
      .eq("id", taskId).eq("tenant_id", r.tenant_id).eq("user_id", r.user_id).eq("worker_id", workerId).eq("status", "leased").eq("attempts", r.attempts).select("*");
    if (e) fail_("fail", e);
    const row = (data ?? [])[0] as Row | undefined;
    if (!row) throw new LeaseLostError(taskId, workerId);
    return toTask(row);
  }

  async reapExpired() {
    const nowIso = iso(this.now());
    const { data, error } = await this.sb.from("tasks").select("*").eq("status", "leased").lt("lease_until", nowIso).limit(500);
    if (error) fail_("reapExpired.scan", error);
    let n = 0;
    for (const r of (data ?? []) as Row[]) {
      const patch: Row = { last_error: "lease expired (worker crashed or stalled)", lease_until: null, worker_id: null };
      if (r.attempts >= r.max_attempts) patch.status = "dead"; else { patch.status = "queued"; patch.run_after = nowIso; }
      const { data: won, error: e2 } = await this.sb.from("tasks").update(patch)
        .eq("id", r.id).eq("tenant_id", r.tenant_id).eq("user_id", r.user_id).eq("status", "leased").eq("attempts", r.attempts).select("id");
      if (e2) fail_("reapExpired", e2);
      n += (won ?? []).length;
    }
    return n;
  }

  private async ownerOf(taskId: string): Promise<Ctx | null> {
    const hit = this.ownerCache.get(taskId);
    if (hit) return hit;
    const { data, error } = await this.sb.from("tasks").select("tenant_id,user_id").eq("id", taskId).maybeSingle();
    if (error) fail_("ownerOf", error);
    if (!data) return null;
    const ctx = { tenantId: (data as Row).tenant_id, userId: (data as Row).user_id };
    this.ownerCache.set(taskId, ctx);
    return ctx;
  }

  async log(taskId: string, level: "debug" | "info" | "warn" | "error", message: string, data: Record<string, unknown> = {}) {
    const o = await this.ownerOf(taskId);
    if (!o) return;
    const { error } = await this.sb.from("task_logs").insert({ tenant_id: o.tenantId, user_id: o.userId, task_id: taskId, level, message: message.slice(0, 2000), data });
    if (error) fail_("log", error);
  }

  async get(ctx: Ctx, id: string) {
    const { data, error } = await this.sb.from("tasks").select("*").eq("tenant_id", ctx.tenantId).eq("user_id", ctx.userId).eq("id", id).maybeSingle();
    if (error) fail_("get", error);
    return data ? toTask(data) : null;
  }

  async list(ctx: Ctx, q: { kind?: TaskKind; status?: TaskStatus; limit?: number } = {}) {
    let qb = this.sb.from("tasks").select("*").eq("tenant_id", ctx.tenantId).eq("user_id", ctx.userId);
    if (q.kind) qb = qb.eq("kind", q.kind);
    if (q.status) qb = qb.eq("status", q.status);
    const { data, error } = await qb.order("created_at", { ascending: false }).limit(q.limit ?? 100);
    if (error) fail_("list", error);
    return (data ?? []).map(toTask);
  }

  async deadLetters(ctx: Ctx, limit = 50) { return this.list(ctx, { status: "dead", limit }); }

  async workerHeartbeat(workerId: string, info: { host?: string; kinds: TaskKind[]; currentTask?: string | null }) {
    const { error } = await this.sb.from("worker_heartbeats").upsert(
      { worker_id: workerId, host: info.host ?? null, kinds: info.kinds, current_task: info.currentTask ?? null, last_seen: iso(this.now()) },
      { onConflict: "worker_id" },
    );
    if (error) fail_("workerHeartbeat", error);
  }
}

// ====================================================================== spend reader (usage_events), used by worker limits
export interface SpendReader { spentUsd(ctx: Ctx, since: Date): Promise<number> }

export function createSpendReader(sb: SupabaseClient = createServiceClient()): SpendReader {
  return {
    async spentUsd(ctx, since) {
      const { data, error } = await sb.from("usage_events").select("cost_usd")
        .eq("tenant_id", ctx.tenantId).eq("user_id", ctx.userId).gte("created_at", since.toISOString()).limit(10000);
      if (error) throw new Error(`createSpendReader: ${error.message}`);
      return (data ?? []).reduce((s: number, r: Row) => s + Number(r.cost_usd ?? 0), 0);
    },
  };
}

export class InMemorySpendReader implements SpendReader {
  private events: Array<{ ctx: Ctx; at: Date; usd: number }> = [];
  add(ctx: Ctx, usd: number, at: Date = new Date()) { this.events.push({ ctx, at, usd }); }
  async spentUsd(ctx: Ctx, since: Date) {
    return this.events.filter((e) => e.ctx.tenantId === ctx.tenantId && e.ctx.userId === ctx.userId && e.at >= since).reduce((s, e) => s + e.usd, 0);
  }
}
