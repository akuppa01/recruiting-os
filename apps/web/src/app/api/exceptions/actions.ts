// Inbox go-ahead actions on an exception. Pure logic with injected dependencies (tested without a database).
// Every lookup is scoped by ctx, so another tenant's exception id is simply "not found".
import type { Ctx, Store, TaskQueue } from "@ros/core";
import { exceptionJobId, nextRetryKey, retryEligibility } from "../../../lib/pipeline-view";

export interface ApplicationLite { id: string; jobId: string; status: string; confirmed: boolean }

export interface ActionDeps {
  store: Store;
  queue: Pick<TaskQueue, "enqueue" | "list">;
  /** All application rows for this tenant + user. */
  applications(ctx: Ctx): Promise<ApplicationLite[]>;
}

export interface ActionResult { status: number; body: Record<string, unknown> }
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): ActionResult => ({ status, body: { error, ...extra } });

type Loaded =
  | { ok: false; result: ActionResult }
  | { ok: true; jobId: string; app: ApplicationLite | null; siblings: string[] };

async function load(deps: ActionDeps, ctx: Ctx, id: string): Promise<Loaded> {
  const all = await deps.store.listExceptions(ctx);
  const ex = all.find((e) => e.id === id);
  if (!ex) return { ok: false, result: fail(404, "not_found") };
  if (ex.resolvedAt) return { ok: false, result: fail(409, "already_resolved") };
  const apps = await deps.applications(ctx);
  const jobOfApp = new Map(apps.map((a) => [a.id, a.jobId]));
  const jobId = exceptionJobId(ex, jobOfApp);
  if (!jobId) return { ok: false, result: fail(400, "not_applicable", { detail: "This item is not tied to a job." }) };
  if (!(await deps.store.getJob(ctx, jobId))) return { ok: false, result: fail(404, "not_found") };
  const siblings = all.filter((e) => !e.resolvedAt && e.id !== id && exceptionJobId(e, jobOfApp) === jobId).map((e) => e.id);
  return { ok: true, jobId, app: apps.find((a) => a.jobId === jobId) ?? null, siblings };
}

/** Go-ahead: queue a fresh apply task for the job and resolve the item. Confirmed and unverified applications are never retried. */
export async function retryException(deps: ActionDeps, ctx: Ctx, id: string): Promise<ActionResult> {
  const l = await load(deps, ctx, id);
  if (!l.ok) return l.result;
  const check = retryEligibility(l.app);
  if (!check.ok) {
    return fail(409, check.reason, {
      detail: check.reason === "already_confirmed" ? "This application is already confirmed." : "An earlier submit may have gone through. Check your email or the company portal before retrying.",
    });
  }
  const existing = await deps.queue.list(ctx, { kind: "apply", limit: 500 });
  const key = nextRetryKey(l.jobId, existing.map((t) => t.idempotencyKey));
  const { task } = await deps.queue.enqueue(ctx, { kind: "apply", payload: { jobId: l.jobId, retryOf: id }, idempotencyKey: key, priority: 5 });
  await deps.store.setJobStage(ctx, l.jobId, "applying");
  await deps.store.resolveException(ctx, id);
  await deps.store.logEvent(ctx, "exception.retry_requested", "exception", id, { jobId: l.jobId, taskId: task.id, idempotencyKey: key });
  return { status: 200, body: { ok: true, taskId: task.id, idempotencyKey: key } };
}

/** Skip: archive the job and resolve this item (and any other open items on the same job). A confirmed application is never archived. */
export async function skipException(deps: ActionDeps, ctx: Ctx, id: string): Promise<ActionResult> {
  const l = await load(deps, ctx, id);
  if (!l.ok) return l.result;
  if (l.app?.confirmed) return fail(409, "already_confirmed", { detail: "This application is already confirmed, so it can't be skipped." });
  await deps.store.setJobStage(ctx, l.jobId, "archived");
  for (const sid of [id, ...l.siblings]) await deps.store.resolveException(ctx, sid);
  await deps.store.logEvent(ctx, "job.skipped", "job", l.jobId, { exceptionId: id, resolvedSiblings: l.siblings.length });
  return { status: 200, body: { ok: true, jobId: l.jobId, resolved: 1 + l.siblings.length } };
}
