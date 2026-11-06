import { NormalizedJob, type Ctx, type Store } from "@ros/core";
import { InMemoryStore, SupabaseStore, hasSupabaseEnv } from "@ros/db";

export const DEMO_CTX: Ctx = { tenantId: "00000000-0000-4000-8000-000000000001", userId: "00000000-0000-4000-8000-000000000002" };

type G = typeof globalThis & { __rosStore?: Store; __rosSeed?: Promise<void> };

/** True when no Supabase env is configured: data lives in process memory and is NOT persisted. */
export function isDemoMode(): boolean { return !hasSupabaseEnv(); }

export async function seedDemo(store: InMemoryStore) {
  const samples: Array<[string, string, string, string, number]> = [
    ["Product Management Intern", "Demo Co (sample)", "product_management", "qualified", 84],
    ["Go-to-Market Strategy Intern", "Sample Labs (sample)", "gtm_strategy", "applied", 78],
    ["Founder's Office Intern", "Placeholder AI (sample)", "founders_office", "scored", 71],
  ];
  for (const [title, company, roleCategory, stage, total] of samples) {
    const ing = await store.createIngestion(DEMO_CTX, { source: "manual_text", text: `${title} @ ${company}`, idempotencyKey: `demo:${title}` });
    const n = NormalizedJob.parse({ title, company, roleCategory, dedupeKey: `demo:${company}:${title}`, description: "SAMPLE DATA — not a real posting." });
    const { job } = await store.upsertJob(DEMO_CTX, ing.id, n);
    await store.updateIngestion(DEMO_CTX, ing.id, { status: "done", jobId: job.id });
    await store.setJobStage(DEMO_CTX, job.id, stage as never, {
      total, roleFit: 1, comp: 1, conversion: 1, responsibility: 1, flexibility: 1, upside: 1, entrepreneurialCompat: 1,
      hardRejects: [], rationale: "demo sample", decision: "qualify",
    });
  }
}

/** Supabase-backed store when env is present, else a process-global InMemoryStore seeded with a demo tenant. */
export function getStore(): Store {
  const g = globalThis as G;
  if (!g.__rosStore) {
    if (hasSupabaseEnv()) g.__rosStore = new SupabaseStore();
    else {
      const s = new InMemoryStore();
      g.__rosStore = s;
      g.__rosSeed = seedDemo(s);
    }
  }
  return g.__rosStore;
}

/** Like getStore() but waits for demo seeding to finish. API handlers use this. */
export async function getStoreAsync(): Promise<Store> {
  const s = getStore();
  await (globalThis as G).__rosSeed;
  return s;
}

/** Test helper. */
export function resetStoreForTests(store?: Store) { const g = globalThis as G; g.__rosStore = store; g.__rosSeed = undefined; }
