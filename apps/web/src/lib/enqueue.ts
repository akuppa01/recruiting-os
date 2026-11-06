// Pipeline trigger hook. Owner: Agent A defines the seam; Agent E wires the real implementation
// (e.g. POST to an n8n webhook or call the in-process pipeline runner) via setEnqueue().
//
// Contract: enqueue must be quick and must NOT throw for "pipeline busy". If no implementation is
// registered (or it fails), the ingestion stays `accepted` and the worker poller (store.claimIngestions)
// picks it up. So an accepted ingestion is never lost, only possibly delayed.
import type { Ctx } from "@ros/core";

export type EnqueueFn = (ctx: Ctx, ingestionId: string) => Promise<void>;

let impl: EnqueueFn | null = null;

export function setEnqueue(fn: EnqueueFn | null) { impl = fn; }
export function hasEnqueue() { return impl !== null; }

export type EnqueueOutcome = "enqueued" | "no_hook" | "failed" | "timeout";

export async function enqueueIngestion(ctx: Ctx, ingestionId: string, timeoutMs = 1500): Promise<{ outcome: EnqueueOutcome; error?: string }> {
  if (!impl) return { outcome: "no_hook" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      impl(ctx, ingestionId).then(() => "ok" as const),
      new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), timeoutMs); }),
    ]);
    return { outcome: res === "ok" ? "enqueued" : "timeout" };
  } catch (e) {
    return { outcome: "failed", error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
