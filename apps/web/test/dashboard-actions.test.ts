import { describe, expect, it } from "vitest";
import { NormalizedJob, type Ctx } from "@ros/core";
import { InMemoryStore, InMemoryTaskQueue } from "@ros/db";
import { retryException, skipException, type ActionDeps, type ApplicationLite } from "../src/app/api/exceptions/actions";

const A: Ctx = { tenantId: "00000000-0000-4000-8000-0000000000a1", userId: "00000000-0000-4000-8000-0000000000a2" };
const B: Ctx = { tenantId: "00000000-0000-4000-8000-0000000000b1", userId: "00000000-0000-4000-8000-0000000000b2" };

async function setup() {
  const store = new InMemoryStore();
  const queue = new InMemoryTaskQueue();
  const apps: ApplicationLite[] = [];
  const deps: ActionDeps = { store, queue, applications: async (c) => apps.filter((a) => a.id.startsWith(c.tenantId.slice(-2))) };

  const mkJob = async (ctx: Ctx, company: string) => {
    const ing = await store.createIngestion(ctx, { source: "manual_text", text: `x @ ${company}`, idempotencyKey: `${ctx.tenantId}:${company}` });
    const { job } = await store.upsertJob(ctx, ing.id, NormalizedJob.parse({ title: "PM Intern", company, dedupeKey: `${company}|pm` }));
    return job;
  };
  const mkApp = async (ctx: Ctx, jobId: string, status: string, confirmed = false) => {
    const { app } = await store.getOrCreateApplication(ctx, jobId);
    apps.push({ id: `${ctx.tenantId.slice(-2)}:${app.id}`, jobId, status, confirmed });
    return app;
  };
  return { store, queue, deps, mkJob, mkApp, apps };
}

describe("retryException", () => {
  it("queues a fresh apply task, moves the job back to applying and resolves the item", async () => {
    const s = await setup();
    const job = await s.mkJob(A, "Acme");
    const app = await s.mkApp(A, job.id, "failed");
    const ex = await s.store.raiseException(A, { type: "missing_profile_field", entityType: "application", entityId: `${A.tenantId.slice(-2)}:${app.id}`, detail: "needs answer" });

    const r = await retryException(s.deps, A, ex.id);
    expect(r.status).toBe(200);
    expect(r.body.idempotencyKey).toBe(`apply:${job.id}:retry:1`);
    const tasks = await s.queue.list(A, { kind: "apply" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.payload).toMatchObject({ jobId: job.id });
    expect((await s.store.getJob(A, job.id))?.stage).toBe("applying");
    expect((await s.store.listExceptions(A, true))).toHaveLength(0);
    expect((await s.store.listEvents(A, { kind: "exception.retry_requested" })).length).toBe(1);
  });

  it("uses the next retry number each time and never double-resolves", async () => {
    const s = await setup();
    const job = await s.mkJob(A, "Acme");
    const first = await s.store.raiseException(A, { type: "other", entityType: "job", entityId: job.id, detail: "one" });
    expect((await retryException(s.deps, A, first.id)).body.idempotencyKey).toBe(`apply:${job.id}:retry:1`);
    expect((await retryException(s.deps, A, first.id)).status).toBe(409); // already resolved
    const second = await s.store.raiseException(A, { type: "other", entityType: "job", entityId: job.id, detail: "two" });
    expect((await retryException(s.deps, A, second.id)).body.idempotencyKey).toBe(`apply:${job.id}:retry:2`);
    expect(await s.queue.list(A, { kind: "apply" })).toHaveLength(2);
  });

  it("refuses to retry a confirmed or unverified application", async () => {
    const s = await setup();
    const j1 = await s.mkJob(A, "Done Co");
    await s.mkApp(A, j1.id, "succeeded", true);
    const e1 = await s.store.raiseException(A, { type: "other", entityType: "job", entityId: j1.id, detail: "x" });
    expect(await retryException(s.deps, A, e1.id)).toMatchObject({ status: 409, body: { error: "already_confirmed" } });

    const j2 = await s.mkJob(A, "Maybe Co");
    await s.mkApp(A, j2.id, "unverified");
    const e2 = await s.store.raiseException(A, { type: "submission_unverified", entityType: "job", entityId: j2.id, detail: "y" });
    expect(await retryException(s.deps, A, e2.id)).toMatchObject({ status: 409, body: { error: "unverified_submission" } });
    expect(await s.queue.list(A, { kind: "apply" })).toHaveLength(0);
    expect(await s.store.listExceptions(A, true)).toHaveLength(2); // nothing was resolved
  });

  it("rejects items that are not tied to a job", async () => {
    const s = await setup();
    const ex = await s.store.raiseException(A, { type: "integration_not_connected", entityType: "integration", entityId: null, detail: "Gmail" });
    expect(await retryException(s.deps, A, ex.id)).toMatchObject({ status: 400, body: { error: "not_applicable" } });
  });

  it("treats another tenant's exception as not found and changes nothing", async () => {
    const s = await setup();
    const job = await s.mkJob(A, "Acme");
    const ex = await s.store.raiseException(A, { type: "other", entityType: "job", entityId: job.id, detail: "x" });
    expect(await retryException(s.deps, B, ex.id)).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect(await skipException(s.deps, B, ex.id)).toMatchObject({ status: 404 });
    expect(await s.queue.list(A, { kind: "apply" })).toHaveLength(0);
    expect((await s.store.getJob(A, job.id))?.stage).toBe("normalized");
    expect(await s.store.listExceptions(A, true)).toHaveLength(1);
  });
});

describe("skipException", () => {
  it("archives the job and resolves this item plus other open items on the same job", async () => {
    const s = await setup();
    const job = await s.mkJob(A, "Acme");
    const other = await s.mkJob(A, "Other");
    const e1 = await s.store.raiseException(A, { type: "other", entityType: "job", entityId: job.id, detail: "a" });
    await s.store.raiseException(A, { type: "captcha", entityType: "job", entityId: job.id, detail: "b" });
    await s.store.raiseException(A, { type: "other", entityType: "job", entityId: other.id, detail: "c" });

    const r = await skipException(s.deps, A, e1.id);
    expect(r).toMatchObject({ status: 200, body: { ok: true, jobId: job.id, resolved: 2 } });
    expect((await s.store.getJob(A, job.id))?.stage).toBe("archived");
    expect((await s.store.getJob(A, other.id))?.stage).toBe("normalized");
    const open = await s.store.listExceptions(A, true);
    expect(open).toHaveLength(1);
    expect(open[0]?.entityId).toBe(other.id);
  });

  it("will not archive a confirmed application", async () => {
    const s = await setup();
    const job = await s.mkJob(A, "Done Co");
    await s.mkApp(A, job.id, "succeeded", true);
    const ex = await s.store.raiseException(A, { type: "other", entityType: "job", entityId: job.id, detail: "x" });
    expect(await skipException(s.deps, A, ex.id)).toMatchObject({ status: 409, body: { error: "already_confirmed" } });
    expect((await s.store.getJob(A, job.id))?.stage).toBe("normalized");
  });
});
