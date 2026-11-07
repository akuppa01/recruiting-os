import { describe, expect, it } from "vitest";
import type { DiscoveredJob, SourceAdapter, SourceRunResult } from "@ros/core";
import { InMemorySourceHealthStore, SupabaseSourceHealthStore, nextHealth, runDiscovery } from "../../src/discovery/index.js";

const A = { tenantId: "ta", userId: "ua" };
const B = { tenantId: "tb", userId: "ub" };
const T0 = new Date("2026-11-07T10:00:00Z");
const T1 = new Date("2026-11-07T11:00:00Z");

const dj = (o: { source?: DiscoveredJob["source"]; url?: string | null; title?: string; company?: string; location?: string; school?: string; description?: string }): DiscoveredJob => ({
  source: o.source ?? "greenhouse", sourceRef: o.url ?? "ref", canonicalUrl: o.url ?? null,
  job: { title: o.title ?? "Product Management Intern", company: o.company ?? "Acme", location: o.location ?? "San Francisco, CA", applyUrl: o.url ?? undefined, description: o.description },
  evidence: { kind: "feed" }, ...(o.school ? { schoolRequirements: o.school } : {}),
});
const adapter = (id: SourceAdapter["id"], r: Partial<SourceRunResult> | (() => never)): SourceAdapter => ({
  id, kind: "feed", run: async () => { if (typeof r === "function") r(); return { source: id, jobs: [], ...(r as Partial<SourceRunResult>) }; },
});

describe("nextHealth", () => {
  it("ok: sets last_success_at, clears the error, accumulates totals", () => {
    const a = nextHealth(null, { source: "greenhouse", jobs: [dj({}), dj({ url: "https://x.com/2" })] }, T0);
    expect(a).toMatchObject({ status: "ok", last_success_at: T0.toISOString(), last_error: null, items_last_run: 2, items_total: 2 });
    const b = nextHealth(a, { source: "greenhouse", jobs: [dj({})] }, T1);
    expect(b).toMatchObject({ status: "ok", items_last_run: 1, items_total: 3, last_success_at: T1.toISOString() });
  });
  it("failed: keeps the previous last_success_at and records the error", () => {
    const ok = nextHealth(null, { source: "lever", jobs: [dj({})] }, T0);
    const bad = nextHealth(ok, { source: "lever", jobs: [], error: "HTTP 503" }, T1);
    expect(bad).toMatchObject({ status: "failed", last_error: "HTTP 503", last_success_at: T0.toISOString(), last_attempt_at: T1.toISOString(), items_last_run: 0, items_total: 1 });
  });
  it("degraded: partial data counts as a success but keeps the error", () => {
    const d = nextHealth(null, { source: "greenhouse", jobs: [dj({})], error: "1/30 boards unavailable" }, T1);
    expect(d).toMatchObject({ status: "degraded", last_success_at: T1.toISOString(), last_error: "1/30 boards unavailable", items_last_run: 1 });
  });
  it("not_configured never claims success", () => {
    const n = nextHealth(null, { source: "handshake", jobs: [], notConfigured: "Gmail not connected" }, T1);
    expect(n).toMatchObject({ status: "not_configured", last_success_at: null, last_error: "Gmail not connected", items_last_run: 0 });
  });
});

describe("InMemorySourceHealthStore", () => {
  it("is isolated per tenant/user", async () => {
    const s = new InMemorySourceHealthStore(() => T0);
    await s.record(A, { source: "greenhouse", jobs: [dj({})] });
    await s.record(B, { source: "greenhouse", jobs: [], error: "boom" });
    expect((await s.list(A)).map((h) => [h.source, h.status])).toEqual([["greenhouse", "ok"]]);
    expect((await s.list(B)).map((h) => [h.source, h.status])).toEqual([["greenhouse", "failed"]]);
  });
});

function fakeSupabase() {
  const rows: Array<Record<string, unknown>> = []; const matches: Array<Record<string, unknown>> = []; const upserts: Array<{ row: Record<string, unknown>; opts: unknown }> = [];
  const filt = (m: Record<string, unknown>) => rows.filter((r) => Object.entries(m).every(([k, v]) => r[k] === v));
  const client = {
    from: (table: string) => {
      if (table !== "source_health") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          match: (m: Record<string, unknown>) => {
            matches.push(m);
            return { maybeSingle: async () => ({ data: filt(m)[0] ?? null, error: null }), order: async () => ({ data: filt(m), error: null }) };
          },
        }),
        upsert: async (row: Record<string, unknown>, opts: unknown) => {
          upserts.push({ row, opts });
          const i = rows.findIndex((r) => r.tenant_id === row.tenant_id && r.user_id === row.user_id && r.source === row.source);
          if (i >= 0) rows[i] = row; else rows.push(row);
          return { error: null };
        },
      };
    },
  };
  return { client: client as unknown as ConstructorParameters<typeof SupabaseSourceHealthStore>[0], matches, upserts, rows };
}

describe("SupabaseSourceHealthStore", () => {
  it("always scopes by tenant_id + user_id, upserts on the composite key, and preserves history", async () => {
    const f = fakeSupabase();
    const s = new SupabaseSourceHealthStore(f.client, () => T0);
    await s.record(A, { source: "lever", jobs: [dj({})] });
    await s.record(A, { source: "lever", jobs: [], error: "HTTP 500" });
    await s.record(B, { source: "lever", jobs: [dj({}), dj({ url: "https://x.com/9" })] });

    expect(f.matches.every((m) => "tenant_id" in m && "user_id" in m)).toBe(true);
    expect(f.upserts.every((u) => (u.opts as { onConflict: string }).onConflict === "tenant_id,user_id,source")).toBe(true);
    const a = (await s.list(A))[0]!;
    expect(a).toMatchObject({ source: "lever", status: "failed", lastError: "HTTP 500", itemsTotal: 1 });
    expect(a.lastSuccessAt).toBe(T0.toISOString());             // survived the later failure
    expect((await s.list(B))[0]).toMatchObject({ status: "ok", itemsTotal: 2 });
  });
});

describe("runDiscovery", () => {
  it("a crashing adapter never blocks the others; health is recorded for all", async () => {
    const health = new InMemorySourceHealthStore(() => T0);
    const r = await runDiscovery(A, {
      healthStore: health,
      adapters: [
        adapter("greenhouse", { jobs: [dj({ url: "https://job-boards.greenhouse.io/acme/jobs/1" })] }),
        adapter("lever", () => { throw new Error("kaboom"); }),
        adapter("handshake", { notConfigured: "Gmail not connected" }),
      ],
    });
    expect(r.jobs).toHaveLength(1);
    expect(r.sources).toEqual([
      { source: "greenhouse", found: 1 },
      { source: "lever", found: 0, error: "adapter crashed: kaboom" },
      { source: "handshake", found: 0, notConfigured: "Gmail not connected" },
    ]);
    const byName = Object.fromEntries((await health.list(A)).map((h) => [h.source, h.status]));
    expect(byName).toEqual({ greenhouse: "ok", lever: "failed", handshake: "not_configured" });
  });

  it("dedupes by canonical URL (tracking variants and custom career pages) and by company|title|location", async () => {
    const r = await runDiscovery(A, {
      adapters: [
        adapter("greenhouse", { jobs: [dj({ url: "https://job-boards.greenhouse.io/databricks/jobs/6883068002", company: "Databricks", title: "PM Intern" })] }),
        adapter("linkedin_alert", { source: "linkedin_alert", jobs: [
          dj({ source: "linkedin_alert", url: "https://databricks.com/careers/job?gh_jid=6883068002&utm_source=li", company: "Databricks", title: "PM Intern" }),
          dj({ source: "linkedin_alert", url: "https://www.linkedin.com/comm/jobs/view/42?trackingId=a", company: "Globex", title: "GTM Intern", location: "New York, NY" }),
        ] }),
        adapter("indeed_alert", { jobs: [
          dj({ source: "indeed_alert", url: "https://www.indeed.com/viewjob?jk=zzz", company: "Globex Inc.", title: "GTM Intern", location: "New York, NY" }),   // same role, different URL
          dj({ source: "indeed_alert", url: "https://www.linkedin.com/jobs/view/42", company: "Globex", title: "GTM Intern", location: "New York, NY" }),
        ] }),
      ],
    });
    expect(r.jobs.map((j) => `${j.job.company}:${j.job.title}`)).toEqual(["Databricks:PM Intern", "Globex:GTM Intern"]);
    expect(r.duplicatesDropped).toBe(3);
  });

  it("canonicalizes URLs and folds missing fields (school requirements, description) into the surviving record", async () => {
    const r = await runDiscovery(A, {
      adapters: [
        adapter("handshake", { jobs: [dj({ source: "handshake", url: "https://cmu.joinhandshake.com/jobs/55?ref=a", company: "Acme" })] }),
        adapter("handshake", { jobs: [dj({ source: "handshake", url: "https://app.joinhandshake.com/stu/jobs/55", company: "Acme", school: "MBA 2028 only", description: "Summer 2027 role" })] }),
      ],
    });
    expect(r.jobs).toHaveLength(1);
    expect(r.jobs[0]!.canonicalUrl).toBe("https://cmu.joinhandshake.com/jobs/55");
    expect(r.jobs[0]!.schoolRequirements).toBe("MBA 2028 only");
    expect(r.jobs[0]!.job.description).toBe("Summer 2027 role");
  });

  it("placeholder-company jobs are not collapsed by content key; a failing health store is reported, not fatal", async () => {
    const brokenStore = { record: async () => { throw new Error("db down"); }, list: async () => [] };
    const r = await runDiscovery(A, {
      healthStore: brokenStore,
      adapters: [adapter("manual", { jobs: [
        dj({ source: "manual", url: "https://a.example.com/jobs/1", company: "Unknown company", title: "Untitled role" }),
        dj({ source: "manual", url: "https://b.example.com/jobs/2", company: "Unknown company", title: "Untitled role" }),
      ] })],
    });
    expect(r.jobs).toHaveLength(2);
    expect(r.sources[0]!.healthError).toBe("db down");
  });
});
