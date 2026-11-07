import { describe, expect, it } from "vitest";
import { NormalizedJob, type Ctx } from "@ros/core";
import { InMemoryStore } from "@ros/db";
import { answerQuestion, detectIntent } from "../src/lib/chief";

const A: Ctx = { tenantId: "00000000-0000-4000-8000-0000000000a1", userId: "00000000-0000-4000-8000-0000000000a2" };
const B: Ctx = { tenantId: "00000000-0000-4000-8000-0000000000b1", userId: "00000000-0000-4000-8000-0000000000b2" };

async function addJob(s: InMemoryStore, ctx: Ctx, company: string, title: string, total: number | null, deadline: string | null = null) {
  const ing = await s.createIngestion(ctx, { source: "manual_text", text: `${title} @ ${company}`, idempotencyKey: `${ctx.tenantId}:${company}:${title}` });
  const n = NormalizedJob.parse({ title, company, dedupeKey: `${company}|${title}`, deadline });
  const { job } = await s.upsertJob(ctx, ing.id, n);
  if (total !== null) {
    await s.setJobStage(ctx, job.id, "qualified", {
      total, roleFit: 1, comp: 1, conversion: 1, responsibility: 1, flexibility: 1, upside: 1, entrepreneurialCompat: 1,
      hardRejects: [], rationale: `why ${company}`, decision: "qualify",
    });
  }
  return job;
}

describe("chief of staff tools", () => {
  it("routes questions to intents", () => {
    expect(detectIntent("what needs me today?")).toBe("blocked");
    expect(detectIntent("show my top roles")).toBe("top");
    expect(detectIntent("anything stalled")).toBe("stalled");
    expect(detectIntent("any interview replies")).toBe("replies");
    expect(detectIntent("hello")).toBe("summary");
  });

  it("ranks only this tenant's jobs by score", async () => {
    const s = new InMemoryStore();
    await addJob(s, A, "LowCo", "PM Intern", 60);
    await addJob(s, A, "HighCo", "PM Intern", 90);
    await addJob(s, B, "OtherTenantCo", "PM Intern", 99);
    const r = await answerQuestion(s, A, "top jobs");
    expect(r.items.map((i) => i.label)).toEqual(["90 · HighCo: PM Intern", "60 · LowCo: PM Intern"]);
    expect(JSON.stringify(r)).not.toContain("OtherTenantCo");
  });

  it("says so when there is no data instead of inventing any", async () => {
    const s = new InMemoryStore();
    expect((await answerQuestion(s, A, "top jobs")).answer).toBe("No scored jobs yet.");
    expect((await answerQuestion(s, A, "any replies?")).answer).toBe("No replies recorded yet.");
    expect((await answerQuestion(s, A, "what's blocked")).answer).toContain("Nothing is blocked");
  });

  it("flags stalled jobs and upcoming deadlines", async () => {
    const s = new InMemoryStore();
    const j = await addJob(s, A, "SlowCo", "GTM Intern", 70, "2099-01-01");
    const future = Date.now() + 5 * 86_400_000;
    const stalled = await answerQuestion(s, A, "what is stalled", future);
    expect(stalled.items[0]?.label).toContain("SlowCo");
    const dl = await answerQuestion(s, A, "upcoming deadlines");
    expect(dl.items[0]?.href).toBe(`/explorer?job=${j.id}`);
  });
});

describe("resolveException", () => {
  it("resolves in-tenant and refuses cross-tenant", async () => {
    const s = new InMemoryStore();
    const e = await s.raiseException(A, { type: "captcha", entityType: "job", entityId: null, detail: "solve it" });
    expect(await s.resolveException(B, e.id)).toBe(false);
    expect((await s.listExceptions(A, true)).length).toBe(1);
    expect(await s.resolveException(A, e.id)).toBe(true);
    expect((await s.listExceptions(A, true)).length).toBe(0);
    expect(await s.resolveException(A, "00000000-0000-4000-8000-00000000ffff")).toBe(false);
  });
});
