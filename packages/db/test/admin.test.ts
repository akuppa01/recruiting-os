import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { InMemoryStore } from "../src/memory.js";
import { InMemoryAdmin, DEFAULT_FLAGS, estimateCostUsd, recordLlmUsage } from "../src/admin.js";
import { generateToken, hashToken } from "../src/tokens.js";
import { mkJob } from "./conformance.js";

const setup = () => {
  const store = new InMemoryStore();
  const admin = new InMemoryAdmin(store);
  const A = { tenantId: randomUUID(), userId: randomUUID() };
  const B = { tenantId: randomUUID(), userId: randomUUID() };
  return { store, admin, A, B };
};

describe("usage metering", () => {
  it("aggregates per metric and isolates tenants", async () => {
    const { admin, A, B } = setup();
    await admin.recordUsage(A, { metric: "applications", quantity: 2 });
    await admin.recordUsage(A, { metric: "llm.output_tokens", quantity: 1000, costUsd: 0.5 });
    await admin.recordUsage(A, { metric: "llm.output_tokens", quantity: 500, costUsd: 0.25 });
    await admin.recordUsage(B, { metric: "applications", quantity: 99 });
    const s = await admin.usageSummary(A);
    expect(s.byMetric.applications).toEqual({ quantity: 2, costUsd: 0, events: 1 });
    expect(s.byMetric["llm.output_tokens"]!.quantity).toBe(1500);
    expect(s.totalCostUsd).toBeCloseTo(0.75);
    expect((await admin.usageSummary(B)).byMetric.applications!.quantity).toBe(99);
  });
  it("does not invent costs: unknown pricing => null/0", async () => {
    expect(estimateCostUsd("some-model", 1000, 1000, {})).toBeNull();
    expect(estimateCostUsd("m", 1_000_000, 500_000, { m: { inputPerM: 2, outputPerM: 10 } })).toBeCloseTo(7);
    const { admin, A } = setup();
    await recordLlmUsage(admin, A, { model: "m", inputTokens: 10, outputTokens: 20 });
    const s = await admin.usageSummary(A);
    expect(s.totalCostUsd).toBe(0);
    expect(s.byMetric["llm.input_tokens"]!.quantity).toBe(10);
    await recordLlmUsage(admin, A, { model: "m", inputTokens: 1_000_000, outputTokens: 0, pricing: { m: { inputPerM: 3, outputPerM: 15 } } });
    expect((await admin.usageSummary(A)).totalCostUsd).toBeCloseTo(3); // total cost (input+output) is attached to the output row
  });
});

describe("feature flags", () => {
  it("risky automation defaults off; per-user override; isolated", async () => {
    const { admin, A, B } = setup();
    expect(DEFAULT_FLAGS.auto_apply).toBe(false);
    expect(await admin.isEnabled(A, "auto_apply")).toBe(false);
    expect(await admin.isEnabled(A, "unknown_flag")).toBe(false);
    expect(await admin.isEnabled(A, "proof_of_work")).toBe(true);
    await admin.setFlag(A, "auto_apply", true);
    expect(await admin.isEnabled(A, "auto_apply")).toBe(true);
    expect(await admin.isEnabled(B, "auto_apply")).toBe(false);
  });
});

describe("export and deletion", () => {
  async function populate() {
    const { store, admin, A, B } = setup();
    for (const c of [A, B]) {
      const ing = await store.createIngestion(c, { source: "manual_text", text: "t" });
      const { job } = await store.upsertJob(c, ing.id, mkJob());
      await store.getOrCreateApplication(c, job.id);
      const co = await store.upsertCompany(c, "Acme", null);
      const ct = await store.upsertContact(c, { ctx: c, companyId: co.id, name: "P", title: null, email: null, linkedinUrl: null, relevance: 1, source: "t" });
      await store.createOutreach(c, { ctx: c, contactId: ct.id, jobId: null, step: 1, channel: "email", status: "draft", subject: "s", body: "b", scheduledFor: null });
      await store.logEvent(c, "k", "job", job.id);
      await store.raiseException(c, { ctx: c, type: "captcha", entityType: "job", entityId: job.id, detail: "d" });
      await store.recordExternalAction(c, { system: "gmail", action: "send", status: "dry_run" });
      await store.setPreferences(c, { excludedCompanies: ["X"] });
      await admin.recordUsage(c, { metric: "m" }); await admin.setFlag(c, "auto_apply", true);
    }
    return { store, admin, A, B };
  }
  it("export contains only the caller's rows", async () => {
    const { admin, A, B } = await populate();
    const ex = await admin.exportUserData(A);
    for (const t of ["ingestions", "jobs", "applications", "companies", "contacts", "outreach_messages", "events", "exceptions", "external_actions", "usage_events", "feature_flags", "preferences"])
      expect(ex.tables[t]!.length, t).toBe(1);
    expect(JSON.stringify(ex)).not.toContain(B.userId);
    expect(() => JSON.stringify(ex)).not.toThrow();
  });
  it("delete requires confirmation, removes all caller rows, leaves other tenants intact", async () => {
    const { store, admin, A, B } = await populate();
    await expect(admin.deleteUserData(A, "wrong")).rejects.toThrow(/confirm/);
    expect((await store.searchJobs(A, {})).length).toBe(1);
    const counts = await admin.deleteUserData(A, A.userId);
    expect(counts.jobs).toBe(1); expect(counts.ingestions).toBe(1); expect(counts.applications).toBe(1);
    const ex = await admin.exportUserData(A);
    for (const [t, rows] of Object.entries(ex.tables)) if (t !== "preferences") expect(rows, t).toHaveLength(0);
    expect((await store.getPreferences(A)).excludedCompanies).toEqual([]); // reset to defaults
    const exB = await admin.exportUserData(B);
    expect(exB.tables.jobs).toHaveLength(1);
    expect(exB.tables.outreach_messages).toHaveLength(1);
    expect((await store.getPreferences(B)).excludedCompanies).toEqual(["X"]);
  });
});

describe("api tokens", () => {
  it("hashes deterministically; tokens are unique and prefixed", () => {
    const a = generateToken(), b = generateToken();
    expect(a.token).toMatch(/^ros_/); expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(hashToken(a.token));
    expect(a.hash).toHaveLength(64);
    expect(a.hash).not.toContain(a.token);
  });
});
