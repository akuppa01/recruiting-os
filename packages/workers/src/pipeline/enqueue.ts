import type { Ctx, IngestRequest, IngestResponse, Store } from "@ros/core";
import { IngestRequest as IngestRequestSchema } from "@ros/core";

/**
 * Accept an ingestion: validate, persist (idempotent on idempotencyKey), log, return the persistent ID immediately.
 * Processing is asynchronous: `trigger` (e.g. n8n webhook call) is fire-and-forget; the worker loop also polls
 * claimIngestions so a failed trigger never loses an item.
 */
export async function enqueueIngestion(store: Store, ctx: Ctx, req: IngestRequest, trigger?: (ingestionId: string) => Promise<void>): Promise<IngestResponse> {
  const parsed = IngestRequestSchema.parse(req);
  const row = await store.createIngestion(ctx, parsed);
  await store.logEvent(ctx, "ingestion.accepted", "ingestion", row.id, { source: parsed.source });
  if (trigger) void trigger(row.id).catch(async (e) => { await store.logEvent(ctx, "ingestion.trigger_failed", "ingestion", row.id, { error: String(e?.message ?? e) }); });
  return { ingestionId: row.id, status: "accepted", duplicateOf: row.jobId ?? null };
}
