// Durable-queue worker loop. Resumes after restart (expired leases are reaped), never lets one failed task block others,
// enforces spend and runtime limits with explicit errors, and stops gracefully.
import { DEFAULT_LIMITS, type Ctx, type Task, type TaskKind } from "@ros/core";
import {
  BudgetExceededError, NonRetryableError, NotWiredError, TaskTimeoutError,
  type RunWorkerOptions, type WorkerEvent, type WorkerHelpers, type WorkerSummary,
} from "./types.js";

const realSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener("abort", done); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
  });

const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const startOfUtcMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const secondsUntilNextUtcDay = (d: Date) => Math.max(60, Math.ceil((startOfUtcDay(d).getTime() + 86_400_000 - d.getTime()) / 1000));
const secondsUntilNextUtcMonth = (d: Date) => Math.max(60, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - d.getTime()) / 1000));

function withTimeout<T>(p: Promise<T>, seconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TaskTimeoutError(seconds)), seconds * 1000); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function runWorker(o: RunWorkerOptions): Promise<WorkerSummary> {
  const { queue, handlers, workerId } = o;
  const limits = o.limits ?? DEFAULT_LIMITS;
  const kinds: TaskKind[] = o.kinds ?? (Object.keys(handlers) as TaskKind[]);
  const concurrency = Math.max(1, o.concurrency ?? 1);
  const leaseSeconds = o.leaseSeconds ?? 120;
  const heartbeatMs = o.heartbeatMs ?? Math.max(1000, (leaseSeconds * 1000) / 3);
  const pollMs = o.pollMs ?? 5000;
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? realSleep;
  const browserKinds = o.browserKinds ?? ["apply", "verify"];
  const noBlindRetry = o.noBlindRetryKinds ?? ["apply"];
  const emit = (e: WorkerEvent) => { try { o.onEvent?.(e); } catch { /* observers must not break the worker */ } };
  const sum: WorkerSummary = { leased: 0, done: 0, failed: 0, retried: 0, leaseLost: 0, budgetSkips: 0, timeouts: 0 };

  // Short-lived cache so a burst of tasks does not hammer usage_events.
  const spendCache = new Map<string, { at: number; day: number; month: number }>();
  async function spendFor(ctx: Ctx) {
    if (!o.spend) return { day: 0, month: 0 };
    const key = `${ctx.tenantId}:${ctx.userId}`, t = now();
    const hit = spendCache.get(key);
    if (hit && t.getTime() - hit.at < 30_000) return hit;
    const [day, month] = await Promise.all([o.spend.spentUsd(ctx, startOfUtcDay(t)), o.spend.spentUsd(ctx, startOfUtcMonth(t))]);
    const v = { at: t.getTime(), day, month };
    spendCache.set(key, v);
    return v;
  }

  async function runOne(task: Task): Promise<void> {
    const started = now().getTime();
    let cost = 0, leaseLost = false;
    const spend = await spendFor(task.ctx).catch(() => ({ day: 0, month: 0 }));
    const aiAllowed = () => spend.day + cost < limits.dailyAiUsd && spend.month + cost < limits.monthlyAiUsd;
    const helpers: WorkerHelpers = {
      log: (level, message, data) => queue.log(task.id, level, message, data).catch(() => undefined),
      addCost(usd) {
        cost += usd;
        if (cost > limits.perApplicationAiUsd) throw new BudgetExceededError("per_application", `$${cost.toFixed(4)} spent on one task, limit $${limits.perApplicationAiUsd}`);
        if (spend.day + cost > limits.dailyAiUsd) throw new BudgetExceededError("daily", `daily AI limit $${limits.dailyAiUsd} reached`);
        if (spend.month + cost > limits.monthlyAiUsd) throw new BudgetExceededError("monthly", `monthly AI limit $${limits.monthlyAiUsd} reached`);
      },
      aiAllowed,
      taskCostUsd: () => cost,
    };
    emit({ type: "task_started", task });
    await helpers.log("info", "started", { worker: workerId, attempt: task.attempts });

    const hb = setInterval(() => {
      queue.heartbeat(task.id, workerId, leaseSeconds).then((ok) => { if (!ok) leaseLost = true; }, () => undefined);
    }, heartbeatMs);

    try {
      const handler = handlers[task.kind];
      if (!handler) throw new NonRetryableError(`no handler registered for ${task.kind}`);
      // Work that needs AI cannot start when the budget is already gone: skip loudly, never silently.
      if (task.payload.requiresAi === true && !aiAllowed()) {
        const scope = spend.day >= limits.dailyAiUsd ? "daily" : "monthly";
        throw new BudgetExceededError(scope, `${scope} AI limit reached; task needs AI and was skipped`);
      }
      const run = handler(task, helpers);
      const result = browserKinds.includes(task.kind) ? await withTimeout(Promise.resolve(run), limits.maxBrowserSeconds) : await run;
      if (leaseLost) { sum.leaseLost++; await helpers.log("warn", "lease lost while running; result discarded"); emit({ type: "lease_lost", task }); return; }
      await queue.complete(task.id, workerId, { result: result ?? undefined, costUsd: cost });
      sum.done++;
      emit({ type: "task_done", task, seconds: (now().getTime() - started) / 1000, costUsd: cost });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (err.name === "LeaseLostError") { sum.leaseLost++; emit({ type: "lease_lost", task }); return; }
      let retry = true, backoff: number | undefined;
      if (err instanceof NonRetryableError) retry = false;
      else if (err instanceof NotWiredError) backoff = 900;
      else if (err instanceof TaskTimeoutError) { sum.timeouts++; emit({ type: "timeout", task, seconds: limits.maxBrowserSeconds }); retry = !noBlindRetry.includes(task.kind); }
      else if (err instanceof BudgetExceededError) {
        sum.budgetSkips++;
        emit({ type: "budget_exceeded", task, scope: err.scope, detail: err.message });
        if (err.scope === "per_application") retry = false;
        else backoff = err.scope === "daily" ? secondsUntilNextUtcDay(now()) : secondsUntilNextUtcMonth(now());
        if (noBlindRetry.includes(task.kind) && cost > 0) retry = false;
      }
      try {
        await helpers.log("error", err.message.slice(0, 500), { retry });
        const after = await queue.fail(task.id, workerId, err.message.slice(0, 1000), { retry, backoffSeconds: backoff, costUsd: cost });
        sum.failed++;
        if (after.status === "queued") sum.retried++;
        emit({ type: "task_failed", task: after, error: err.message, retry });
      } catch (e2) {
        if ((e2 as Error).name === "LeaseLostError") { sum.leaseLost++; emit({ type: "lease_lost", task }); }
        else throw e2;
      }
    } finally {
      clearInterval(hb);
    }
  }

  // Resume after a restart/crash: anything a dead worker still holds goes back to the queue.
  await queue.reapExpired();
  let lastReap = now().getTime();
  const inflight = new Set<Promise<void>>();

  while (!o.signal?.aborted) {
    await queue.workerHeartbeat(workerId, { host: o.host, kinds, currentTask: null }).catch(() => undefined);
    if (now().getTime() - lastReap > 30_000) { await queue.reapExpired().catch(() => 0); lastReap = now().getTime(); }

    const free = concurrency - inflight.size;
    const leased = free > 0 ? await queue.lease(workerId, kinds, { limit: free, leaseSeconds }) : [];
    sum.leased += leased.length;
    for (const t of leased) {
      const p: Promise<void> = runOne(t).catch(async (e) => { await queue.log(t.id, "error", `worker error: ${(e as Error).message}`).catch(() => undefined); })
        .finally(() => { inflight.delete(p); });
      inflight.add(p);
    }
    if (leased.length === 0 && inflight.size === 0) {
      if (o.drain) break;
      await sleep(pollMs, o.signal);
    } else if (leased.length === 0 || inflight.size >= concurrency) {
      // Tasks are running: wait for one to finish or a short real timer. Never the injected sleep, which may resolve instantly.
      await Promise.race([...inflight, realSleep(Math.min(pollMs, 1000), o.signal)]);
    }
  }
  await Promise.allSettled([...inflight]);   // graceful stop: finish what was already started
  return sum;
}
