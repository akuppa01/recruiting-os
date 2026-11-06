import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { InMemoryStore } from "@ros/db";
import { randomUUID } from "node:crypto";
import { DEMO_CTX, resetStoreForTests, getStoreAsync, seedDemo } from "../src/lib/store";
import { setEnqueue } from "../src/lib/enqueue";
import { POST as ingest } from "../src/app/api/ingest/route";
import { GET as ingestGet } from "../src/app/api/ingest/[id]/route";
import { GET as pipeline } from "../src/app/api/pipeline/route";
import { GET as jobs } from "../src/app/api/jobs/route";
import { GET as jobGet } from "../src/app/api/jobs/[id]/route";
import { GET as prefsGet, PUT as prefsPut } from "../src/app/api/preferences/route";
import { GET as exceptionsGet } from "../src/app/api/exceptions/route";

const URL_ = "http://localhost/api/x";
const req = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(URL_, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

let store: InMemoryStore;
beforeEach(async () => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.ROS_API_TOKEN;
  store = new InMemoryStore();
  resetStoreForTests(store);
  await seedDemo(store);
  setEnqueue(null);
});
afterEach(() => { setEnqueue(null); vi.restoreAllMocks(); });

describe("POST /api/ingest", () => {
  it("accepts a URL, returns 202 + persisted ingestion id immediately", async () => {
    const res = await ingest(req("POST", { source: "manual_url", url: "https://boards.greenhouse.io/acme/jobs/123" }));
    expect(res.status).toBe(202);
    expect(res.headers.get("x-ros-demo")).toBe("1");
    const body = await res.json();
    expect(body.status).toBe("accepted");
    expect(body.ingestionId).toMatch(/^[0-9a-f-]{36}$/);
    const row = await store.getIngestion(DEMO_CTX, body.ingestionId);
    expect(row?.status).toBe("accepted");
    expect((await store.listEvents(DEMO_CTX, { kind: "ingestion.accepted" })).length).toBe(1);
  });
  it("accepts text, file refs and structured jobs", async () => {
    for (const b of [{ text: "Great PM intern job" }, { fileRef: "u/x.pdf" }, { job: { title: "PM", company: "Acme" } }]) {
      expect((await ingest(req("POST", b))).status).toBe(202);
    }
  });
  it("is idempotent on body idempotencyKey and Idempotency-Key header", async () => {
    const a = await (await ingest(req("POST", { url: "https://x.com/a", idempotencyKey: "k1" }))).json();
    const b = await (await ingest(req("POST", { url: "https://x.com/a", idempotencyKey: "k1" }))).json();
    expect(b.ingestionId).toBe(a.ingestionId);
    const c = await (await ingest(req("POST", { url: "https://x.com/b" }, { "idempotency-key": "h1" }))).json();
    const d = await (await ingest(req("POST", { url: "https://x.com/b" }, { "idempotency-key": "h1" }))).json();
    expect(d.ingestionId).toBe(c.ingestionId);
    expect((await store.listEvents(DEMO_CTX, { kind: "ingestion.accepted" })).length).toBe(2); // repeats do not re-trigger
  });
  it("rejects invalid bodies", async () => {
    expect((await ingest(req("POST", {}))).status).toBe(400);
    expect((await ingest(req("POST", { url: "not a url" }))).status).toBe(400);
    expect((await ingest(req("POST", "{bad json"))).status).toBe(400);
    expect((await ingest(req("POST", { text: "x".repeat(200_001) }))).status).toBe(413);
  });
  it("calls the enqueue hook once with the ingestion id", async () => {
    const fn = vi.fn(async () => {});
    setEnqueue(fn);
    const { ingestionId } = await (await ingest(req("POST", { text: "hello job" }))).json();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(DEMO_CTX, ingestionId);
  });
  it("still accepts (and logs) when the enqueue hook throws; ingestion remains claimable", async () => {
    setEnqueue(async () => { throw new Error("n8n down"); });
    const res = await ingest(req("POST", { text: "hello job" }));
    expect(res.status).toBe(202);
    const { ingestionId } = await res.json();
    expect((await store.listEvents(DEMO_CTX, { kind: "ingestion.enqueue_failed" })).length).toBe(1);
    expect((await store.claimIngestions(100)).some((i) => i.id === ingestionId)).toBe(true);
  });
  it("does not block on a hung enqueue hook", async () => {
    setEnqueue(() => new Promise(() => {}));
    const t = Date.now();
    const res = await ingest(req("POST", { text: "hello job" }));
    expect(res.status).toBe(202);
    expect(Date.now() - t).toBeLessThan(3000);
  }, 10_000);
});

describe("auth", () => {
  it("demo mode with ROS_API_TOKEN set requires the bearer token", async () => {
    process.env.ROS_API_TOKEN = "s3cret-token";
    expect((await pipeline(req("GET"))).status).toBe(401);
    expect((await pipeline(req("GET", undefined, { authorization: "Bearer wrong" }))).status).toBe(401);
    expect((await pipeline(req("GET", undefined, { authorization: "Bearer s3cret-token" }))).status).toBe(200);
  });
  it("is closed in production demo mode without a token", async () => {
    const prev = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    try { expect((await pipeline(req("GET"))).status).toBe(401); } finally { (process.env as Record<string, string>).NODE_ENV = prev!; }
  });
});

describe("GET /api/ingest/[id]", () => {
  it("returns status and linked job; 404 for other tenants; 400 for bad ids", async () => {
    const ing = await store.createIngestion(DEMO_CTX, { text: "x" });
    const ok = await ingestGet(req("GET"), params(ing.id));
    expect(ok.status).toBe(200);
    expect((await ok.json()).ingestion.status).toBe("accepted");
    const other = await store.createIngestion({ tenantId: randomUUID(), userId: randomUUID() }, { text: "secret" });
    expect((await ingestGet(req("GET"), params(other.id))).status).toBe(404);
    expect((await ingestGet(req("GET"), params("nope"))).status).toBe(400);
    expect((await ingestGet(req("GET"), params(randomUUID()))).status).toBe(404);
  });
});

describe("read endpoints", () => {
  it("pipeline counts demo seed and open exceptions", async () => {
    await store.raiseException(DEMO_CTX, { ctx: DEMO_CTX, type: "captcha", entityType: "job", entityId: null, detail: "d" });
    const b = await (await pipeline(req("GET"))).json();
    expect(b.total).toBe(3);
    expect(b.counts.qualified).toBe(1);
    expect(b.openExceptions).toBe(1);
  });
  it("jobs supports filters and validates query", async () => {
    const all = await (await jobs(req("GET"))).json();
    expect(all.count).toBe(3);
    const q = new Request("http://localhost/api/jobs?stage=qualified&minScore=80");
    expect((await (await jobs(q)).json()).count).toBe(1);
    expect((await (await jobs(new Request("http://localhost/api/jobs?q=founder"))).json()).count).toBe(1);
    expect((await jobs(new Request("http://localhost/api/jobs?stage=bogus"))).status).toBe(400);
    expect((await jobs(new Request("http://localhost/api/jobs?limit=9999"))).status).toBe(400);
  });
  it("job detail includes application and events; other tenant's job is 404", async () => {
    const [j] = await store.searchJobs(DEMO_CTX, { limit: 1 });
    await store.logEvent(DEMO_CTX, "job.scored", "job", j!.id);
    const b = await (await jobGet(req("GET"), params(j!.id))).json();
    expect(b.job.id).toBe(j!.id);
    expect(b.application).toBeNull();
    expect(b.events.length).toBe(1);
    const otherCtx = { tenantId: randomUUID(), userId: randomUUID() };
    const ing = await store.createIngestion(otherCtx, { text: "z" });
    const { job } = await store.upsertJob(otherCtx, ing.id, j!.normalized);
    expect((await jobGet(req("GET"), params(job.id))).status).toBe(404);
  });
  it("exceptions lists open by default, all with open=false", async () => {
    const e = await store.raiseException(DEMO_CTX, { ctx: DEMO_CTX, type: "captcha", entityType: "job", entityId: null, detail: "d" });
    expect((await (await exceptionsGet(req("GET"))).json()).count).toBe(1);
    (await store.listExceptions(DEMO_CTX))[0]!.resolvedAt = new Date().toISOString();
    expect((await (await exceptionsGet(req("GET"))).json()).count).toBe(0);
    expect((await (await exceptionsGet(new Request("http://localhost/api/exceptions?open=false"))).json()).count).toBe(1);
    expect(e.id).toBeTruthy();
  });
});

describe("preferences", () => {
  it("defaults to dry_run", async () => {
    const b = await (await prefsGet(req("GET"))).json();
    expect(b.preferences.policy.mode).toBe("dry_run");
  });
  it("deep-merges policy and weights without resetting siblings", async () => {
    await prefsPut(req("PUT", { policy: { minScoreToApply: 70 } }));
    await prefsPut(req("PUT", { policy: { maxApplicationsPerDay: 5 }, weights: { comp: 0.3 } }));
    const p = (await (await prefsGet(req("GET"))).json()).preferences;
    expect(p.policy.minScoreToApply).toBe(70);
    expect(p.policy.maxApplicationsPerDay).toBe(5);
    expect(p.policy.mode).toBe("dry_run");
    expect(p.weights.comp).toBe(0.3);
    expect(p.weights.roleFit).toBe(0.35);
  });
  it("switching to live requires explicit confirmLive", async () => {
    const no = await prefsPut(req("PUT", { policy: { mode: "live" } }));
    expect(no.status).toBe(400);
    expect((await store.getPreferences(DEMO_CTX)).policy.mode).toBe("dry_run");
    const yes = await prefsPut(req("PUT", { policy: { mode: "live" }, confirmLive: true }));
    expect(yes.status).toBe(200);
    expect((await store.getPreferences(DEMO_CTX)).policy.mode).toBe("live");
    expect((await store.listEvents(DEMO_CTX, { kind: "preferences.updated" })).at(-1)!.payload.liveSwitched).toBe(true);
  });
  it("rejects unknown keys and invalid values", async () => {
    expect((await prefsPut(req("PUT", { bogus: 1 }))).status).toBe(400);
    expect((await prefsPut(req("PUT", { policy: { mode: "yolo" } }))).status).toBe(400);
  });
});

describe("demo store", () => {
  it("getStoreAsync seeds a demo tenant when no Supabase env", async () => {
    resetStoreForTests(undefined);
    const s = await getStoreAsync();
    expect((await s.searchJobs(DEMO_CTX, {})).length).toBe(3);
  });
});
