// Wires the ingest route to the pipeline. Decision D-006:
//  - If N8N_BASE_URL + N8N_WEBHOOK_SECRET are set: POST to the n8n webhook (durable path).
//  - Otherwise: run the pipeline in-process, fire-and-forget (dev/demo only; serverless may kill it,
//    which is safe because the ingestion stays `accepted` and any later processPending() call claims it).
import { createDefaultStages, makeTriggerFromEnv, processPending } from "@ros/workers";
import { setEnqueue, hasEnqueue } from "./enqueue";
import { getStoreAsync } from "./store";

export function bootPipeline() {
  if (hasEnqueue()) return;
  const n8n = makeTriggerFromEnv();
  if (n8n) { setEnqueue(n8n); return; }
  const stages = createDefaultStages();
  setEnqueue(async () => {
    const store = await getStoreAsync();
    void processPending(store, stages, { limit: 5, baseDelayMs: 50 }).catch((e) => console.error("[pipeline] in-process run failed", e?.message ?? e));
  });
}
