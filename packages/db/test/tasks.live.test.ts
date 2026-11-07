// LIVE smoke test for SupabaseTaskQueue against the real project. Skipped unless ROS_LIVE_SMOKE=1.
// Safety: uses the one existing tenant, only idempotency keys prefixed "zz-test:", only kind 'verify', refuses to run if any
// non-test 'verify' task exists, and deletes every row it creates (asserted in afterAll).
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "@ros/core";
import { SupabaseTaskQueue, createServiceClient } from "../src/index.js";

function loadEnv() {
  for (const line of readFileSync(new URL("../../../.env.local", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)=(.*)$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
  }
}

describe.skipIf(!process.env.ROS_LIVE_SMOKE)("SupabaseTaskQueue (LIVE)", () => {
  let sb: ReturnType<typeof createServiceClient>;
  let ctx: Ctx;
  let q: SupabaseTaskQueue;
  let t = Date.now();
  const run = `zz-test:${Date.now()}`;
  const clock = () => new Date(t);
  const cleanup = async () => {
    await sb.from("tasks").delete().like("idempotency_key", "zz-test:%");
    await sb.from("worker_heartbeats").delete().like("worker_id", "zz-test-%");
  };

  beforeAll(async () => {
    loadEnv();
    sb = createServiceClient();
    const { data, error } = await sb.from("profiles").select("tenant_id,user_id");
    if (error || !data || data.length !== 1) throw new Error("expected exactly one profile; refusing to run live smoke test");
    ctx = { tenantId: data[0]!.tenant_id, userId: data[0]!.user_id };
    const other = await sb.from("tasks").select("id", { count: "exact", head: true }).eq("kind", "verify").not("idempotency_key", "like", "zz-test:%");
    if ((other.count ?? 0) > 0) throw new Error("non-test 'verify' tasks exist; refusing to run");
    await cleanup();
    q = new SupabaseTaskQueue(sb, clock);
  });
  afterAll(async () => {
    await cleanup();
    const left = await sb.from("tasks").select("id", { count: "exact", head: true }).like("idempotency_key", "zz-test:%");
    expect(left.count).toBe(0);
  });

  it("idempotent enqueue, priority lease, concurrency, retry/backoff, dead-letter, expiry, cost, logs, heartbeat", async () => {
    // idempotency
    const a1 = await q.enqueue(ctx, { kind: "verify", idempotencyKey: `${run}:a` });
    const a2 = await q.enqueue(ctx, { kind: "verify", idempotencyKey: `${run}:a` });
    expect(a1.created).toBe(true); expect(a2.created).toBe(false); expect(a2.task.id).toBe(a1.task.id);

    // 7 more tasks with distinct priorities; 4 concurrent workers must never share a task
    for (let i = 0; i < 7; i++) await q.enqueue(ctx, { kind: "verify", idempotencyKey: `${run}:p${i}`, priority: i });
    const batches = await Promise.all(["zz-test-w1", "zz-test-w2", "zz-test-w3", "zz-test-w4"].map((w) => q.lease(w, ["verify"], { limit: 2 })));
    const leased = batches.flat();
    expect(leased.every((x) => x.idempotencyKey.startsWith("zz-test:"))).toBe(true);
    expect(new Set(leased.map((x) => x.id)).size).toBe(leased.length);
    expect(leased.length).toBe(8);

    // complete + cost, fail retry with backoff, fail terminal, lease loss
    const [first, second, third, fourth] = leased;
    await q.complete(first!.id, first!.workerId!, { result: { ok: 1 }, costUsd: 0.01 });
    expect((await q.get(ctx, first!.id))?.status).toBe("done");
    expect((await q.get(ctx, first!.id))?.costUsd).toBeCloseTo(0.01, 6);
    const f = await q.fail(second!.id, second!.workerId!, "boom", { backoffSeconds: 60, costUsd: 0.02 });
    expect(f.status).toBe("queued");
    expect(await q.lease("zz-test-w1", ["verify"])).toEqual([]);          // backoff not elapsed
    const term = await q.fail(third!.id, third!.workerId!, "uncertain", { retry: false });
    expect(term.status).toBe("failed");
    await expect(q.complete(fourth!.id, "zz-test-someone-else")).rejects.toThrow(/lease lost/);

    // heartbeat extends; lease expiry recovers; dead-letter at max attempts
    expect(await q.heartbeat(fourth!.id, fourth!.workerId!, 30)).toBe(true);
    t += 31_000;                                                          // all remaining leases + the backoff have expired
    const reaped = await q.reapExpired();
    expect(reaped).toBeGreaterThanOrEqual(1);
    const dl = await q.enqueue(ctx, { kind: "verify", idempotencyKey: `${run}:dead`, maxAttempts: 1, priority: 100 });
    const [d] = await q.lease("zz-test-w1", ["verify"]);
    expect(d?.id).toBe(dl.task.id);
    expect((await q.fail(d!.id, "zz-test-w1", "final")).status).toBe("dead");
    expect((await q.deadLetters(ctx)).some((x) => x.id === dl.task.id)).toBe(true);

    // logs + worker heartbeat rows
    await q.log(dl.task.id, "error", "dead after one attempt", { n: 1 });
    const logs = await sb.from("task_logs").select("message").eq("task_id", dl.task.id);
    expect(logs.data?.map((l) => l.message)).toContain("dead after one attempt");
    await q.workerHeartbeat("zz-test-w1", { host: "smoke", kinds: ["verify"], currentTask: null });
    const hb = await sb.from("worker_heartbeats").select("worker_id").eq("worker_id", "zz-test-w1");
    expect(hb.data?.length).toBe(1);
  }, 120_000);
});
