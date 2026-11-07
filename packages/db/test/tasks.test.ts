import { describe, expect, it } from "vitest";
import type { Ctx, TaskQueue } from "@ros/core";
import { InMemorySpendReader, InMemoryTaskQueue, LeaseLostError } from "../src/tasks.js";

const A: Ctx = { tenantId: "00000000-0000-4000-8000-0000000000a1", userId: "00000000-0000-4000-8000-0000000000a2" };
const B: Ctx = { tenantId: "00000000-0000-4000-8000-0000000000b1", userId: "00000000-0000-4000-8000-0000000000b2" };

/** Controllable clock so lease expiry and backoff are tested without sleeping. */
function make() {
  let t = Date.parse("2026-11-07T12:00:00.000Z");
  const q = new InMemoryTaskQueue(() => new Date(t));
  return { q, advance: (ms: number) => { t += ms; }, now: () => new Date(t) };
}

export function taskQueueConformance(name: string, factory: () => { q: TaskQueue; advance: (ms: number) => void }) {
  describe(`TaskQueue conformance: ${name}`, () => {
    it("enqueue is idempotent per (tenant, user, key) and isolated between owners", async () => {
      const { q } = factory();
      const a1 = await q.enqueue(A, { kind: "discover", idempotencyKey: "k1" });
      const a2 = await q.enqueue(A, { kind: "discover", idempotencyKey: "k1" });
      const b1 = await q.enqueue(B, { kind: "discover", idempotencyKey: "k1" });
      expect(a1.created).toBe(true);
      expect(a2.created).toBe(false);
      expect(a2.task.id).toBe(a1.task.id);
      expect(b1.created).toBe(true);
      expect(b1.task.id).not.toBe(a1.task.id);
      expect(await q.get(B, a1.task.id)).toBeNull();
      expect((await q.list(A)).length).toBe(1);
    });

    it("leases by priority, then age, and respects runAfter and kind", async () => {
      const { q, advance } = factory();
      await q.enqueue(A, { kind: "apply", idempotencyKey: "low", priority: 0 });
      await q.enqueue(A, { kind: "apply", idempotencyKey: "high", priority: 10 });
      await q.enqueue(A, { kind: "qualify", idempotencyKey: "other-kind", priority: 99 });
      await q.enqueue(A, { kind: "apply", idempotencyKey: "later", priority: 50, runAfter: new Date(Date.now() + 10 * 365 * 86400_000).toISOString() });
      const got = await q.lease("w1", ["apply"], { limit: 5 });
      expect(got.map((t) => t.idempotencyKey)).toEqual(["high", "low"]);
      expect(got.every((t) => t.status === "leased" && t.attempts === 1 && t.workerId === "w1")).toBe(true);
      advance(0);
    });

    it("N workers leasing at once never share a task", async () => {
      const { q } = factory();
      for (let i = 0; i < 25; i++) await q.enqueue(A, { kind: "apply", idempotencyKey: `t${i}` });
      const batches = await Promise.all(Array.from({ length: 8 }, (_, w) => q.lease(`w${w}`, ["apply"], { limit: 4 })));
      const ids = batches.flat().map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBe(25);
    });

    it("an expired lease is recoverable by reapExpired and by a new lease; the old worker loses the lease", async () => {
      const { q, advance } = factory();
      const { task } = await q.enqueue(A, { kind: "apply", idempotencyKey: "crash" });
      const [leased] = await q.lease("dead-worker", ["apply"], { leaseSeconds: 10 });
      expect(leased?.id).toBe(task.id);
      expect(await q.lease("w2", ["apply"])).toEqual([]);            // still leased
      advance(11_000);
      expect(await q.reapExpired()).toBe(1);
      const [again] = await q.lease("w2", ["apply"]);
      expect(again?.id).toBe(task.id);
      expect(again?.attempts).toBe(2);
      expect(await q.heartbeat(task.id, "dead-worker")).toBe(false);
      await expect(q.complete(task.id, "dead-worker")).rejects.toBeInstanceOf(LeaseLostError);
      await q.complete(task.id, "w2", { result: { ok: true } });
      expect((await q.get(A, task.id))?.status).toBe("done");
    });

    it("leasing directly picks up an expired lease without needing reapExpired", async () => {
      const { q, advance } = factory();
      await q.enqueue(A, { kind: "apply", idempotencyKey: "direct" });
      await q.lease("w1", ["apply"], { leaseSeconds: 5 });
      advance(6_000);
      const got = await q.lease("w2", ["apply"]);
      expect(got.length).toBe(1);
      expect(got[0]?.workerId).toBe("w2");
    });

    it("heartbeat extends the lease so a slow worker keeps its task", async () => {
      const { q, advance } = factory();
      const { task } = await q.enqueue(A, { kind: "apply", idempotencyKey: "slow" });
      await q.lease("w1", ["apply"], { leaseSeconds: 10 });
      advance(8_000);
      expect(await q.heartbeat(task.id, "w1", 10)).toBe(true);
      advance(8_000);
      expect(await q.reapExpired()).toBe(0);
      expect(await q.lease("w2", ["apply"])).toEqual([]);
    });

    it("fail re-queues with backoff, then dead-letters at maxAttempts", async () => {
      const { q, advance } = factory();
      const { task } = await q.enqueue(A, { kind: "apply", idempotencyKey: "flaky", maxAttempts: 2 });
      await q.lease("w1", ["apply"]);
      const f1 = await q.fail(task.id, "w1", "boom 1", { backoffSeconds: 60 });
      expect(f1.status).toBe("queued");
      expect(f1.lastError).toBe("boom 1");
      expect(await q.lease("w1", ["apply"])).toEqual([]);            // backoff not elapsed
      advance(61_000);
      const [second] = await q.lease("w1", ["apply"]);
      expect(second?.attempts).toBe(2);
      const f2 = await q.fail(task.id, "w1", "boom 2");
      expect(f2.status).toBe("dead");
      expect((await q.deadLetters(A)).map((t) => t.id)).toEqual([task.id]);
      expect(await q.lease("w1", ["apply"])).toEqual([]);
    });

    it("fail with retry=false is terminal 'failed' (not dead-lettered, never retried)", async () => {
      const { q } = factory();
      const { task } = await q.enqueue(A, { kind: "apply", idempotencyKey: "uncertain" });
      await q.lease("w1", ["apply"]);
      const f = await q.fail(task.id, "w1", "submission uncertain", { retry: false });
      expect(f.status).toBe("failed");
      expect(await q.lease("w1", ["apply"])).toEqual([]);
      expect(await q.deadLetters(A)).toEqual([]);
    });

    it("a task that keeps crashing is dead-lettered instead of looping forever", async () => {
      const { q, advance } = factory();
      const { task } = await q.enqueue(A, { kind: "apply", idempotencyKey: "crashy", maxAttempts: 2 });
      for (let i = 0; i < 2; i++) { await q.lease(`w${i}`, ["apply"], { leaseSeconds: 5 }); advance(6_000); await q.reapExpired(); }
      expect((await q.get(A, task.id))?.status).toBe("dead");
    });

    it("accumulates cost across failed and completed attempts", async () => {
      const { q, advance } = factory();
      const { task } = await q.enqueue(A, { kind: "tailor", idempotencyKey: "cost" });
      await q.lease("w1", ["tailor"]);
      await q.fail(task.id, "w1", "x", { costUsd: 0.02, backoffSeconds: 1 });
      advance(2_000);
      await q.lease("w1", ["tailor"]);
      await q.complete(task.id, "w1", { costUsd: 0.03 });
      expect((await q.get(A, task.id))?.costUsd).toBeCloseTo(0.05, 6);
    });

    it("records worker heartbeats", async () => {
      const { q } = factory();
      await q.workerHeartbeat("w1", { host: "mac", kinds: ["apply"], currentTask: null });
      expect((q as unknown as InMemoryTaskQueue).heartbeats.get("w1")?.kinds).toEqual(["apply"]);
    });
  });
}

taskQueueConformance("InMemoryTaskQueue", () => { const m = make(); return { q: m.q, advance: m.advance }; });

describe("InMemoryTaskQueue extras", () => {
  it("stores task logs", async () => {
    const { q } = make();
    const { task } = await q.enqueue(A, { kind: "discover", idempotencyKey: "log" });
    await q.log(task.id, "info", "started", { n: 1 });
    expect(q.logsFor(task.id).map((l) => l.message)).toEqual(["started"]);
  });
  it("spend reader sums per owner and window", async () => {
    const r = new InMemorySpendReader();
    r.add(A, 1.5, new Date("2026-11-07T01:00:00Z")); r.add(A, 2, new Date("2026-11-01T00:00:00Z")); r.add(B, 9, new Date("2026-11-07T01:00:00Z"));
    expect(await r.spentUsd(A, new Date("2026-11-07T00:00:00Z"))).toBe(1.5);
    expect(await r.spentUsd(A, new Date("2026-11-01T00:00:00Z"))).toBe(3.5);
  });
});
