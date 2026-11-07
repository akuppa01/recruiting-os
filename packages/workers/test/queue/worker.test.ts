import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, type Ctx, type TaskHandler } from "@ros/core";
import { InMemorySpendReader, InMemoryTaskQueue } from "@ros/db";
import { NonRetryableError, NotWiredError, createDefaultHandlers, runWorker, type WorkerEvent, type WorkerHelpers } from "../../src/queue/index.js";

const A: Ctx = { tenantId: "00000000-0000-4000-8000-0000000000a1", userId: "00000000-0000-4000-8000-0000000000a2" };

function clock() {
  let t = Date.parse("2026-11-07T12:00:00.000Z");
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; }, sleep: async (ms: number) => { t += ms; } };
}
const base = (c: ReturnType<typeof clock>) => ({ now: c.now, sleep: c.sleep, heartbeatMs: 1_000_000, pollMs: 1000, drain: true as const });

describe("runWorker", () => {
  it("processes tasks and stores results", async () => {
    const c = clock(); const q = new InMemoryTaskQueue(c.now);
    const { task } = await q.enqueue(A, { kind: "qualify", idempotencyKey: "a", payload: { n: 2 } });
    const sum = await runWorker({ ...base(c), queue: q, workerId: "w1", handlers: { qualify: async (t) => ({ doubled: Number(t.payload.n) * 2 }) } });
    expect(sum.done).toBe(1);
    const got = await q.get(A, task.id);
    expect(got?.status).toBe("done");
    expect(got?.result).toEqual({ doubled: 4 });
  });

  it("a failing task never blocks the others; it is retried with backoff, then dead-lettered", async () => {
    const c = clock(); const q = new InMemoryTaskQueue(c.now);
    const bad = (await q.enqueue(A, { kind: "qualify", idempotencyKey: "bad", maxAttempts: 2 })).task;
    const good = (await q.enqueue(A, { kind: "qualify", idempotencyKey: "good" })).task;
    const handlers = { qualify: (async (t) => { if (t.idempotencyKey === "bad") throw new Error("boom"); return { ok: true }; }) as TaskHandler };
    let s = await runWorker({ ...base(c), queue: q, workerId: "w1", handlers });
    expect(s.done).toBe(1);
    expect((await q.get(A, good.id))?.status).toBe("done");
    expect((await q.get(A, bad.id))?.status).toBe("queued");             // waiting for backoff
    c.advance(10 * 60_000);
    s = await runWorker({ ...base(c), queue: q, workerId: "w1", handlers });
    expect((await q.get(A, bad.id))?.status).toBe("dead");
    expect((await q.deadLetters(A)).length).toBe(1);
  });

  it("NonRetryableError fails terminally with no retry", async () => {
    const c = clock(); const q = new InMemoryTaskQueue(c.now);
    const { task } = await q.enqueue(A, { kind: "apply", idempotencyKey: "x" });
    await runWorker({ ...base(c), queue: q, workerId: "w1", handlers: { apply: async () => { throw new NonRetryableError("unsupported ATS"); } } });
    const got = await q.get(A, task.id);
    expect(got?.status).toBe("failed");
    expect(got?.lastError).toContain("unsupported ATS");
  });

  it("resumes after a crash: a task held by a dead worker is recovered and finished", async () => {
    const c = clock(); const q = new InMemoryTaskQueue(c.now);
    const { task } = await q.enqueue(A, { kind: "apply", idempotencyKey: "crash" });
    await q.lease("crashed-worker", ["apply"], { leaseSeconds: 5 });   // worker 1 leased it and died
    c.advance(6_000);
    await runWorker({ ...base(c), queue: q, workerId: "w2", handlers: { apply: async () => ({ done: true }) } });
    const got = await q.get(A, task.id);
    expect(got?.status).toBe("done");
    expect(got?.attempts).toBe(2);
  });

  it("only leases kinds that have handlers; other work stays queued", async () => {
    const c = clock(); const q = new InMemoryTaskQueue(c.now);
    await q.enqueue(A, { kind: "outreach", idempotencyKey: "o" });
    const { task } = await q.enqueue(A, { kind: "qualify", idempotencyKey: "q" });
    const sum = await runWorker({ ...base(c), queue: q, workerId: "w1", handlers: { qualify: async () => undefined } });
    expect(sum.leased).toBe(1);
    expect((await q.list(A, { kind: "outreach" }))[0]?.status).toBe("queued");
    expect((await q.get(A, task.id))?.status).toBe("done");
  });

  it("enforces the per-application AI budget with an explicit error", async () => {
    const c = clock(); const q = new InMemoryTaskQueue(c.now);
    const { task } = await q.enqueue(A, { kind: "tailor", idempotencyKey: "t" });
    const events: WorkerEvent[] = [];
    await runWorker({ ...base(c), queue: q, workerId: "w1", onEvent: (e) => events.push(e),
      limits: { ...DEFAULT_LIMITS, perApplicationAiUsd: 0.1 }, handlers: { tailor: async (_t, h) => { h.addCost(0.06); h.addCost(0.06); return {}; } } });
    const got = await q.get(A, task.id);
    expect(got?.status).toBe("failed");
    expect(got?.lastError).toMatch(/^budget_exceeded:per_application/);
    expect(events.some((e) => e.type === "budget_exceeded")).toBe(true);
  });

  it("skips AI-requiring work when the daily budget is already spent, and defers it to tomorrow", async () => {
    const c = clock(); const q = new InMemoryTaskQueue(c.now);
    const spend = new InMemorySpendReader(); spend.add(A, 5, c.now());
    const ai = (await q.enqueue(A, { kind: "tailor", idempotencyKey: "ai", payload: { requiresAi: true } })).task;
    const det = (await q.enqueue(A, { kind: "qualify", idempotencyKey: "det" })).task;
    let sawAiAllowed: boolean | null = null;
    const events: WorkerEvent[] = [];
    await runWorker({ ...base(c), queue: q, workerId: "w1", spend, onEvent: (e) => events.push(e), limits: { ...DEFAULT_LIMITS, dailyAiUsd: 2 },
      handlers: { tailor: async () => ({}), qualify: async (_t, h) => { sawAiAllowed = (h as WorkerHelpers).aiAllowed(); return {}; } } });
    expect((await q.get(A, det.id))?.status).toBe("done");               // deterministic work is not blocked by the AI budget
    expect(sawAiAllowed).toBe(false);                                    // ...but knows it must stay deterministic
    const skipped = await q.get(A, ai.id);
    expect(skipped?.status).toBe("queued");
    expect(skipped?.lastError).toMatch(/^budget_exceeded:daily/);
    expect(new Date(skipped!.runAfter).getTime()).toBeGreaterThan(c.now().getTime() + 3600_000);   // not before tomorrow-ish
    expect(events.some((e) => e.type === "budget_exceeded" && e.scope === "daily")).toBe(true);
  });

  it("times out browser work and never blindly retries apply", async () => {
    const c = clock(); const q = new InMemoryTaskQueue(c.now);
    const { task } = await q.enqueue(A, { kind: "apply", idempotencyKey: "slow" });
    const sum = await runWorker({ ...base(c), queue: q, workerId: "w1", limits: { ...DEFAULT_LIMITS, maxBrowserSeconds: 0.05 },
      handlers: { apply: () => new Promise(() => undefined) } });
    expect(sum.timeouts).toBe(1);
    const got = await q.get(A, task.id);
    expect(got?.status).toBe("failed");
    expect(got?.lastError).toMatch(/^timeout/);
  });

  it("heartbeats while running and discards the result if the lease was lost", async () => {
    const c = clock(); const q = new InMemoryTaskQueue(c.now);
    const { task } = await q.enqueue(A, { kind: "qualify", idempotencyKey: "lost" });
    let beats = 0;
    const flaky = Object.create(q) as InMemoryTaskQueue;
    flaky.heartbeat = async () => { beats++; return false; };
    let completed = false;
    flaky.complete = async () => { completed = true; };
    const sum = await runWorker({ ...base(c), heartbeatMs: 5, queue: flaky, workerId: "w1", handlers: { qualify: async () => { await new Promise((r) => setTimeout(r, 60)); return {}; } } });
    expect(beats).toBeGreaterThan(0);
    expect(sum.leaseLost).toBe(1);
    expect(completed).toBe(false);
    expect((await q.get(A, task.id))?.status).toBe("leased");            // untouched: the new owner decides
  });

  it("stops gracefully on abort after finishing in-flight work", async () => {
    const c = clock(); const q = new InMemoryTaskQueue(c.now);
    const { task } = await q.enqueue(A, { kind: "qualify", idempotencyKey: "g" });
    const ac = new AbortController();
    const sum = await runWorker({ queue: q, workerId: "w1", now: c.now, heartbeatMs: 1_000_000, pollMs: 5, signal: ac.signal,
      handlers: { qualify: async () => { ac.abort(); await new Promise((r) => setTimeout(r, 20)); return { finished: true }; } } });
    expect(sum.done).toBe(1);
    expect((await q.get(A, task.id))?.result).toEqual({ finished: true });
  });

  it("createDefaultHandlers wires injected handlers and pushes back unwired kinds", async () => {
    const c = clock(); const q = new InMemoryTaskQueue(c.now);
    const { handlers, wired, unwired } = createDefaultHandlers({ qualify: async () => ({ ok: 1 }) });
    expect(wired).toEqual(["qualify"]);
    expect(unwired).toContain("apply");
    await expect(handlers.apply!({} as never, {} as never)).rejects.toBeInstanceOf(NotWiredError);
    const { task } = await q.enqueue(A, { kind: "apply", idempotencyKey: "nw" });
    await runWorker({ ...base(c), queue: q, workerId: "w1", handlers, kinds: ["apply"] });
    const got = await q.get(A, task.id);
    expect(got?.status).toBe("queued");                                   // not failed, not dropped
    expect(new Date(got!.runAfter).getTime()).toBeGreaterThanOrEqual(c.now().getTime() + 800_000);
  });
});
