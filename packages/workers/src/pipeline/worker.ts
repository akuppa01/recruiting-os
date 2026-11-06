import type { Store } from "@ros/core";
import { runPipeline } from "./run.js";
import type { PipelineOpts, PipelineOutcome, PipelineStages } from "./types.js";

/** Claim accepted ingestions and run each through the pipeline. Safe to call repeatedly (cron / n8n / loop). */
export async function processPending(store: Store, stages: PipelineStages, opts: PipelineOpts & { limit?: number } = {}): Promise<{ processed: number; outcomes: PipelineOutcome[] }> {
  const rows = await store.claimIngestions(opts.limit ?? 10);
  const outcomes: PipelineOutcome[] = [];
  for (const r of rows) outcomes.push(await runPipeline(store, r.ctx, r.id, stages, opts));
  return { processed: rows.length, outcomes };
}

export async function workerLoop(store: Store, stages: PipelineStages, o: PipelineOpts & { intervalMs?: number; signal?: AbortSignal } = {}) {
  while (!o.signal?.aborted) {
    const { processed } = await processPending(store, stages, o);
    if (processed === 0) await new Promise((r) => setTimeout(r, o.intervalMs ?? 5000));
  }
}
